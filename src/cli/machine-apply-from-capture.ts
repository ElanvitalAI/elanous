import { Option, type Command } from 'commander';
import { win32 } from 'node:path';
import { applyMachineSetupPlan, type MachineSetupApplyDeps, type MachineSetupApplyResult } from './machine-setup-apply.js';
import { buildMachineSetupPlan, formatMachineSetupPlan, readMachineCaptureForPlan } from './machine-setup-plan.js';
import { applyMachineWslBootstrap, applyMachineWslProfile, machineWslResumeTaskDefinitionPath, runMachineWslCommand, WSL_RESUME_FAILURE_GUIDANCE, type MachineWslSetupDeps } from './machine-wsl-setup.js';

export interface MachineApplyFromCaptureDeps extends MachineSetupApplyDeps {
  readonly platform?: () => string;
  readonly wsl?: MachineWslSetupDeps;
}

const WSL_CODEX_CREDENTIAL_GUIDANCE = 'Before WSL setup, sign in once with codex login --device-auth on Windows. Windows owns Codex credentials; WSL setup does not create or refresh them. Windows-to-WSL access-only mirror delivery is a follow-up.';

export function currentMachineSetupPlatform(env: NodeJS.ProcessEnv = process.env, runtimePlatform = process.platform): string {
  if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) return 'wsl';
  if (runtimePlatform === 'darwin') return 'macos';
  if (runtimePlatform === 'linux') return 'linux';
  if (runtimePlatform === 'win32') return 'wsl';
  throw new Error(`machine apply is unsupported on ${runtimePlatform}`);
}

export function applyMachineCapture(input: {
  readonly capture: unknown;
  readonly profile: string;
  readonly platform: string;
  readonly distribution?: string;
  readonly confirmed: boolean;
  readonly run?: MachineSetupApplyDeps['run'];
  readonly root?: boolean;
}): MachineSetupApplyResult {
  // The source capture identifies repositories to register. Its installed package
  // list is not target state: every selected profile item remains in the plan.
  const plan = buildMachineSetupPlan({
    profile: input.profile,
    platform: input.platform,
    sourceCapture: input.capture,
    ...(input.distribution ? { distribution: input.distribution } : {}),
  });
  return applyMachineSetupPlan({
    plan,
    confirmed: input.confirmed,
    ...(input.run ? { run: input.run } : {}),
    ...(input.root !== undefined ? { root: input.root } : {}),
  });
}

export function registerMachineApplyFromCaptureCommand(command: Command, deps: MachineApplyFromCaptureDeps = {}): void {
  const out = deps.out ?? { log: (value: string) => console.log(value) };
  const err = deps.err ?? { error: (value: string) => console.error(value) };
  const setExitCode = deps.setExitCode ?? ((code: number) => { process.exitCode = code; });
  command
    .requiredOption('--from <capture>', 'source machine-capture JSON; package values and dotfiles are never copied')
    .option('--profile <profile>', 'default, developer, or headquarters', 'default')
    .option('--platform <platform>', 'target platform; inferred from the current host when omitted')
    .option('--distribution <name>', 'WSL distribution to create', 'Ubuntu')
    .option('--resume-trigger <trigger>', 'Windows WSL resume trigger: onlogon (installing user)', 'onlogon')
    .addOption(new Option('--resume-task-wrapper <file>').hideHelp())
    .option('--wsl-user <name>', 'Linux account to create in the WSL distribution', 'elanous')
    .option('--resume', 'resume WSL setup after reboot; normally started by the scheduled task')
    .option('--allow-cloud-vm', 'explicitly continue WSL2 setup on a detected cloud VM despite reboot risk')
    .option('--yes', 'explicitly approve running package-manager commands')
    .option('--json', 'structured stdout; command stdout is suppressed while interactive prompts remain on the terminal')
    .action((options: { from: string; profile: string; platform?: string; distribution: string; resumeTrigger: 'onstart' | 'onlogon'; wslUser: string; resume?: boolean; resumeTaskWrapper?: string; allowCloudVm?: boolean; yes?: boolean; json?: boolean }) => {
      try {
        if (options.resumeTrigger !== 'onlogon') throw new Error('--resume-trigger must be onlogon because WSL requires the installing Windows account');
        const capture = readMachineCaptureForPlan(options.from);
        const platform = options.platform ?? (deps.platform ?? currentMachineSetupPlatform)();
        const wslHost = platform === 'wsl' && (deps.wsl?.platform ?? process.platform) === 'win32';
        const capturePath = wslHost ? win32.resolve(options.from) : options.from;
        if (!options.yes && !options.json) {
          const plan = buildMachineSetupPlan({ profile: options.profile, platform, sourceCapture: capture,
            ...(platform === 'wsl' ? { distribution: options.distribution } : {}) });
          out.log(`${wslHost ? `${WSL_CODEX_CREDENTIAL_GUIDANCE}\n\n` : ''}${formatMachineSetupPlan(plan)}\n\nNo commands executed. Add --yes to apply.`);
          return;
        }
        if (platform === 'wsl' && (deps.wsl?.platform ?? process.platform) === 'win32') {
          if (!options.yes) {
            const plan = buildMachineSetupPlan({ profile: options.profile, platform: 'wsl', sourceCapture: capture,
              distribution: options.distribution });
            out.log(JSON.stringify({ kind: 'machine-wsl-setup-plan', profile: options.profile,
              distribution: options.distribution, user: options.wslUser, requiresYes: true,
              credentialGuidance: WSL_CODEX_CREDENTIAL_GUIDANCE, plan }, null, 2));
            return;
          }
          if (!options.json) out.log(WSL_CODEX_CREDENTIAL_GUIDANCE);
          const bootstrap = applyMachineWslBootstrap({ capture: capturePath, profile: options.profile,
            distribution: options.distribution, user: options.wslUser, resume: options.resume === true, resumeTrigger: options.resumeTrigger,
            deps: { ...deps.wsl, resumeTaskWrapperPath: options.resumeTaskWrapper,
              allowCloudVm: options.allowCloudVm === true } });
          const profileResult = bootstrap.status === 'complete'
            ? applyMachineWslProfile({ plan: buildMachineSetupPlan({ profile: options.profile, platform: 'wsl', sourceCapture: capture,
              distribution: options.distribution }),
              distribution: options.distribution, user: options.wslUser, run: deps.wsl?.run ?? runMachineWslCommand,
              resumeTaskDefinitionPath: machineWslResumeTaskDefinitionPath(deps.wsl?.env ?? process.env, deps.wsl?.resumeTaskDefinitionPath),
              resumeTaskWrapperPath: options.resumeTaskWrapper })
            : undefined;
          const result = profileResult ? { ...bootstrap, status: profileResult.failures.length ? 'failed' as const : 'complete' as const,
            attempted: bootstrap.attempted + profileResult.attempted, profileResult,
            failures: profileResult.failures.map(item => ({ operation: item.operation, reason: `${item.target}: ${item.reason}` })) }
            : bootstrap;
          if (options.json) out.log(JSON.stringify({ ...result, credentialGuidance: WSL_CODEX_CREDENTIAL_GUIDANCE,
            ...(result.status === 'failed' ? { resumeGuidance: WSL_RESUME_FAILURE_GUIDANCE } : {}) }, null, 2));
          else if (result.status === 'resume-pending') out.log(`machine apply · ${result.detail}`);
          else {
            out.log(`machine apply · WSL ${result.status} · ${result.distribution}/${result.user} · attempted ${result.attempted} · failures ${result.failures.length}`);
            if (result.failures.length) out.log(result.failures.map(item => `${item.operation}: ${item.reason}`).join('\n'));
            if (result.status === 'failed') err.error(WSL_RESUME_FAILURE_GUIDANCE);
            if (profileResult?.manual.length) out.log(`manual steps: ${profileResult.manual.join(', ')}`);
          }
          if (result.status === 'failed') setExitCode(1);
          return;
        }
        const result = applyMachineCapture({
          capture,
          profile: options.profile,
          platform,
          ...(platform === 'wsl' ? { distribution: options.distribution } : {}),
          confirmed: options.yes === true,
          ...(deps.run ? { run: deps.run } : {}),
          ...(deps.root !== undefined ? { root: deps.root } : {}),
        });
        if (options.json) out.log(JSON.stringify(result, null, 2));
        else {
          const summary = result.failures.map(item => `${item.operation} (${item.target}): ${item.reason}`);
          out.log(`machine apply · ${platform} · attempted ${result.attempted} · succeeded ${result.succeeded} · failures ${result.failures.length} · manual ${result.manual.length}`);
          if (summary.length) out.log(summary.join('\n'));
          if (!result.applied) err.error('machine apply blocked; inspect the source capture and plan before retrying');
        }
        if (options.yes && (result.failures.length || !result.applied)) setExitCode(1);
      } catch (error) {
        err.error(error instanceof Error ? error.message : 'machine apply failed');
        setExitCode(1);
      }
    });
}
