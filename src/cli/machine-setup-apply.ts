import { spawnSync } from 'node:child_process';
import type { Command } from 'commander';
import { buildMachineSetupPlan, readMachineCaptureForPlan, type MachineSetupOperation, type MachineSetupPlan } from './machine-setup-plan.js';

export interface MachineSetupApplyFailure {
  readonly operation: string;
  readonly target: string;
  readonly reason: string;
}

export interface MachineSetupApplyResult {
  readonly kind: 'machine-setup-apply-result';
  readonly profile: MachineSetupPlan['profile'];
  readonly platform: MachineSetupPlan['platform'];
  readonly applied: boolean;
  readonly attempted: number;
  readonly succeeded: number;
  readonly failures: readonly MachineSetupApplyFailure[];
  readonly manual: readonly string[];
}

export interface MachineSetupApplyDeps {
  readonly run?: (command: string, args: readonly string[]) => { readonly status: number | null; readonly errorCode?: string };
  readonly out?: { log(value: string): void };
  readonly err?: { error(value: string): void };
  readonly setExitCode?: (code: number) => void;
  readonly root?: boolean;
}

function defaultRun(command: string, args: readonly string[]): { status: number | null; errorCode?: string } {
  const authenticationPrompt = command === 'sudo' && args[0] === '-v';
  const result = spawnSync(command, [...args], {
    timeout: 15 * 60_000,
    windowsHide: true,
    // Let sudo use the user's terminal for authentication without exposing
    // package-manager output or buffering an unbounded install transcript.
    stdio: ['inherit', 'ignore', authenticationPrompt ? 'inherit' : 'ignore'],
  });
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    return { status: null, ...(code ? { errorCode: code } : {}) };
  }
  return { status: result.status };
}

function commandFor(operation: MachineSetupOperation, root: boolean): { command: string; args: string[]; target: string } | undefined {
  if (operation.phase === 'host') return undefined;
  if (operation.id === 'brew-preflight') return { command: 'brew', args: ['--version'], target: 'Homebrew' };
  if (operation.id.startsWith('brew-tap-') && operation.manager === 'brew') {
    const tap = operation.command?.[2];
    if (!tap || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(tap)) return undefined;
    return { command: 'brew', args: ['tap', tap], target: tap };
  }
  if (operation.id.endsWith('-apt-refresh') && operation.manager === 'apt-get') {
    return { command: root ? 'apt-get' : 'sudo', args: root ? ['update'] : ['apt-get', 'update'], target: 'apt metadata' };
  }
  return undefined;
}

function packageCommand(operation: MachineSetupOperation, root: boolean): { command: string; args: string[]; target: string } | undefined {
  const manager = operation.manager;
  const name = operation.packages?.length === 1 ? operation.packages[0] : undefined;
  if (!name) return undefined;
  if (manager === 'brew' ? !/^(?:[A-Za-z0-9][A-Za-z0-9@+._-]*\/){0,2}[A-Za-z0-9][A-Za-z0-9@+._-]*$/.test(name)
    : !/^[A-Za-z0-9@+._-]+$/.test(name)) return undefined;
  if (manager === 'apt-get') return {
    command: root ? 'apt-get' : 'sudo',
    args: root ? ['install', '--yes', '--no-install-recommends', name] : ['apt-get', 'install', '--yes', '--no-install-recommends', name],
    target: name,
  };
  if (manager === 'brew') return {
    command: 'brew',
    args: ['install', ...(operation.packageKind === 'cask' ? ['--cask'] : []), name],
    target: name,
  };
  if (manager === 'cargo') return {
    command: 'cargo',
    args: ['install', '--locked', name],
    target: name,
  };
  return undefined;
}

export function applyMachineSetupPlan(input: {
  readonly plan: MachineSetupPlan;
  readonly confirmed: boolean;
  readonly run?: MachineSetupApplyDeps['run'];
  readonly root?: boolean;
}): MachineSetupApplyResult {
  const { plan } = input;
  const manual = plan.operations.filter(operation => operation.id !== 'brew-preflight'
    && (operation.phase === 'host' || operation.kind === 'manual' || operation.kind === 'checkpoint'
      || operation.kind === 'install' && operation.manager === 'manual'))
    .map(operation => operation.id);
  manual.push(...plan.packages.filter(item => item.manager === 'manual').map(item => item.name));
  const manualSteps = [...new Set(manual)];
  const unresolved = plan.operations.some(operation => operation.id === 'confirm-tap-inventory' || operation.id === 'confirm-unknown-inventory')
    || plan.packages.some(item => item.presence === 'unknown');
  const resultBase = {
    kind: 'machine-setup-apply-result' as const,
    profile: plan.profile,
    platform: plan.platform,
    manual: manualSteps,
  };
  if (!input.confirmed || unresolved) {
    return { ...resultBase, applied: false, attempted: 0, succeeded: 0,
      failures: unresolved ? [{ operation: 'inventory-check', target: 'capture', reason: 'inventory is incomplete; recapture before applying' }] : [] };
  }

  const run = input.run ?? defaultRun;
  const failures: MachineSetupApplyFailure[] = [];
  let attempted = 0;
  let succeeded = 0;
  const root = input.root ?? (typeof process.getuid === 'function' && process.getuid() === 0);
  const needsSudo = !root && plan.operations.some(operation => operation.phase !== 'host'
    && operation.manager === 'apt-get' && (operation.id.endsWith('-apt-refresh') || operation.kind === 'install'));
  if (needsSudo) {
    const auth = run('sudo', ['-v']);
    if (auth.status !== 0) {
      failures.push({ operation: 'sudo-authentication', target: 'sudo',
        reason: auth.status === null && auth.errorCode ? `command unavailable (${auth.errorCode})` : `exit ${auth.status ?? 'unknown'}` });
      return { ...resultBase, applied: false, attempted, succeeded, failures };
    }
  }
  for (const operation of plan.operations) {
    if (operation.kind === 'install' && (operation.phase === 'host' || operation.manager === 'manual')) continue;
    const invocation = operation.kind === 'install' ? packageCommand(operation, root) : commandFor(operation, root);
    if (!invocation) {
      if (operation.kind === 'install') failures.push({ operation: operation.id,
        target: operation.packages?.join(', ') || operation.id, reason: 'unsupported install operation' });
      continue;
    }
    attempted += 1;
    const result = run(invocation.command, invocation.args);
    if (result.status === 0) succeeded += 1;
    else failures.push({
      operation: operation.id,
      target: invocation.target,
      reason: result.status === null && result.errorCode ? `command unavailable (${result.errorCode})` : `exit ${result.status ?? 'unknown'}`,
    });
  }
  return { ...resultBase, applied: true, attempted, succeeded, failures };
}

export function registerMachineSetupApplyCommand(command: Command, deps: MachineSetupApplyDeps = {}): void {
  const out = deps.out ?? { log: (value: string) => console.log(value) };
  const err = deps.err ?? { error: (value: string) => console.error(value) };
  const setExitCode = deps.setExitCode ?? ((code: number) => { process.exitCode = code; });
  command
    .option('--profile <profile>', 'default, developer, or headquarters', 'default')
    .requiredOption('--platform <platform>', 'macos, linux, or wsl')
    .option('--capture <file>', 'captured source machine profile; required to register captured Homebrew taps')
    .option('--yes', 'explicitly approve running package-manager commands')
    .option('--json', 'structured result; command output is never forwarded')
    .action((options: { profile: string; platform: string; capture?: string; yes?: boolean; json?: boolean }) => {
      try {
        const capture = options.capture ? readMachineCaptureForPlan(options.capture) : undefined;
        const plan = buildMachineSetupPlan({ profile: options.profile, platform: options.platform,
          ...(capture ? { capture } : {}) });
        const result = applyMachineSetupPlan({ plan, confirmed: options.yes === true,
          ...(deps.run ? { run: deps.run } : {}), ...(deps.root !== undefined ? { root: deps.root } : {}) });
        if (options.json) out.log(JSON.stringify(result, null, 2));
        else if (!options.yes) out.log('machine setup apply · dry-run · no commands executed · add --yes to apply');
        else {
          const summary = result.failures.map(item => `${item.operation} (${item.target}): ${item.reason}`);
          out.log(`machine setup apply · ${result.platform} · attempted ${result.attempted} · succeeded ${result.succeeded} · failures ${result.failures.length} · manual ${result.manual.length}`);
          if (summary.length) out.log(summary.join('\n'));
          if (!result.applied) err.error('machine setup blocked; refresh the captured inventory before applying');
        }
        if (options.yes && (result.failures.length || !result.applied)) setExitCode(1);
      } catch (error) {
        err.error(error instanceof Error ? error.message : 'machine setup apply failed');
        setExitCode(1);
      }
    });
}
