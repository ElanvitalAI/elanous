import { spawnSync } from 'node:child_process';
import { chmodSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Command } from 'commander';
import { MACHINE_NAME, resolveMachineName } from '../roles/machine-name.js';
import { readMachineProfile, writeMachineProfile } from '../roles/machine-profile.js';
import { applyMachineSetupPlan } from './machine-setup-apply.js';
import { buildMachineSetupPlan, readMachineCaptureForPlan, type MachineSetupPlatform, type MachineSetupProfile } from './machine-setup-plan.js';

export type MachineGridRole = 'headquarters' | 'gate' | 'pod' | 'worker';
type ProcessResult = { readonly status: number | null; readonly stdout?: string; readonly errorCode?: string };

export interface MachineMembershipDeps {
  readonly machine?: () => string;
  readonly platform?: () => MachineSetupPlatform;
  readonly hostPlatform?: NodeJS.Platform;
  readonly run?: (command: string, args: readonly string[], interactive?: boolean) => ProcessResult;
  readonly setup?: (profile: MachineSetupProfile, platform: MachineSetupPlatform, capture?: string) => { readonly applied: boolean; readonly failures: readonly unknown[] };
  readonly output?: { log(value: string): void; error(value: string): void };
  readonly setExitCode?: (code: number) => void;
  readonly root?: string;
  readonly now?: () => Date;
}

const ROLES: readonly MachineGridRole[] = ['headquarters', 'gate', 'pod', 'worker'];
const GRID_ROLE_SET = new Set<string>(ROLES);
const NODE_SETUP_SCRIPT = fileURLToPath(new URL('../../scripts/fleet/node-setup.sh', import.meta.url));

function currentPlatform(): MachineSetupPlatform {
  if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) return 'wsl';
  if (process.platform === 'darwin') return 'macos';
  if (process.platform === 'win32') return 'wsl';
  return 'linux';
}

function defaultRun(command: string, args: readonly string[], interactive = false): ProcessResult {
  const result = spawnSync(command, [...args], {
    encoding: 'utf8',
    timeout: 30 * 60_000,
    windowsHide: true,
    stdio: interactive ? ['inherit', 'inherit', 'inherit'] : ['ignore', 'pipe', 'ignore'],
  });
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    return { status: null, ...(code ? { errorCode: code } : {}) };
  }
  return { status: result.status, ...(typeof result.stdout === 'string' ? { stdout: result.stdout } : {}) };
}

function defaultSetup(profile: MachineSetupProfile, platform: MachineSetupPlatform, capture?: string) {
  const source = capture ? readMachineCaptureForPlan(capture) : undefined;
  const plan = buildMachineSetupPlan({ profile, platform, ...(source ? { capture: source } : {}) });
  return applyMachineSetupPlan({ plan, confirmed: true });
}

function tailscaleIsRunning(result: ProcessResult): boolean {
  if (result.status !== 0 || !result.stdout) return false;
  try {
    const value = JSON.parse(result.stdout) as { BackendState?: unknown };
    return value.BackendState === 'Running';
  } catch { return false; }
}

function tailscaleBinary(hostPlatform: NodeJS.Platform): string {
  return hostPlatform === 'win32' ? 'tailscale.exe' : 'tailscale';
}

function isRole(value: string): value is MachineGridRole {
  return GRID_ROLE_SET.has(value);
}

function isPlatform(value: string): value is MachineSetupPlatform {
  return value === 'macos' || value === 'linux' || value === 'wsl';
}

function operatorJoinLines(machine: string, role: MachineGridRole, cloud: boolean, capacity?: number): string[] {
  const lines = ['External registration = OP executes these steps; this command never runs or edits OP tools or ledgers.'];
  if (cloud) {
    lines.push(`OP only: zsh ~/elanous-hq/seat-state/OP/tools/cloud-join.sh ${machine}${capacity === undefined ? '' : ` --caps ${capacity}`}`);
  }
  if (role === 'pod' || role === 'worker' || role === 'gate') {
    lines.push(`OP only: review host-caps capacity for ${machine}${capacity === undefined ? '' : ` (${capacity})`}`);
  }
  if (role === 'pod') lines.push(`OP only: add ${machine} to the reviewed harness.podPool value`);
  return lines;
}

function operatorLeaveLines(machine: string, roles: readonly MachineGridRole[], cloud: boolean): string[] {
  const resourceRole = roles.some(role => role === 'gate' || role === 'pod' || role === 'worker');
  const lines = ['External registration = OP executes these steps; this command never runs or edits OP tools or ledgers.'];
  if (cloud) lines.push(`OP only: zsh ~/elanous-hq/seat-state/OP/tools/cloud-leave.sh ${machine} (drain → stop; never terminate)`);
  else if (resourceRole) lines.push('OP only: drain assigned work → stop host (never terminate)');
  if (resourceRole) lines.push(`OP only: after drain/stop, remove ${machine} from host-caps.tsv`);
  if (roles.includes('pod')) lines.push(`OP only: remove ${machine} from the reviewed harness.podPool value`);
  return lines;
}

function addLocalRole(machine: string, role: MachineGridRole, resourceCapGiB: number, joinedAt: string, root?: string): void {
  const old = readMachineProfile(root);
  if (old && old.id !== machine) throw new Error(`machine profile id ${old.id} differs from current machine ${machine}`);
  const duties = [...(old?.duties ?? [])];
  if (!duties.includes(role)) duties.push(role);
  writeMachineProfile({ id: machine, duties, seats: { ...(old?.seats ?? {}) }, membership: { role, resourceCapGiB, joinedAt } }, root);
}

function removeLocalMembership(machine: string, root?: string): boolean {
  const old = readMachineProfile(root);
  if (!old || old.id !== machine || !old.membership) return false;
  const { membership: _membership, ...profile } = old;
  writeMachineProfile(profile, root);
  return true;
}

function shellQuote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }

function writeOperatorScript(path: string, kind: 'join' | 'leave', machine: string, role: MachineGridRole | undefined,
  cloud: boolean, capacity?: number): void {
  const tool = (name: string) => `"\${HOME}/elanous-hq/seat-state/OP/tools/${name}.sh"`;
  const lines = [
    '#!/usr/bin/env bash', 'set -euo pipefail', '',
    '# Generated plan for OP. Product machine commands never execute or edit these HQ-only tools/data.',
    '# Run only on an OP-controlled host after reviewing the explicit registration steps below.',
    '[[ "${ELANOUS_OP_APPROVED:-}" == "1" ]] || { echo "set ELANOUS_OP_APPROVED=1 only after OP approves this plan" >&2; exit 2; }',
    `MACHINE=${shellQuote(machine)}`,
    `ROLE=${shellQuote(role ?? 'declared')}`,
    `CAPACITY_GIB=${shellQuote(capacity === undefined ? '' : String(capacity))}`,
    'confirm_manual_step() {',
    '  local expected="$1" message="$2" answer',
    '  read -r -p "$message Type $expected to continue: " answer',
    '  [[ "$answer" == "$expected" ]] || { echo "stopped before next operation" >&2; exit 2; }',
    '}',
    '',
  ];
  if (kind === 'join') {
    lines.push('case "${1:-apply}" in', '  apply)',
      '    # 1. OP approval and capacity/pool review happen before cloud admission.',
      '    # OP manually records the reviewed role and resource ceiling in host-caps.tsv.',
      ...(role === 'pod' ? ['    # OP manually adds the approved pod to harness.podPool.'] : []),
      `    confirm_manual_step ${shellQuote(`JOIN-READY:${machine}:${role}:${capacity ?? ''}`)} ${shellQuote('After updating host-caps.tsv and any podPool entry,')} `);
    if (cloud) lines.push(`    zsh ${tool('cloud-join')} "$MACHINE"${capacity === undefined ? '' : ' --caps "$CAPACITY_GIB"'}`);
    lines.push('    ;;', '  rollback)',
      '    # Reverse OP-owned host-caps.tsv and podPool edits first; verify no assigned work remains.',
      `    confirm_manual_step ${shellQuote(`ROLLBACK-READY:${machine}`)} ${shellQuote('After reverting host-caps/podPool and draining assigned work,')}`,
      ...(cloud ? [`    zsh ${tool('cloud-leave')} "$MACHINE"`] : ['    echo "OP: run the approved cloud leave operation for $MACHINE" >&2; exit 2']),
      '    ;;', '  *) echo "usage: $0 [apply|rollback]" >&2; exit 2 ;;', 'esac');
  } else {
    lines.push('case "${1:-apply}" in', '  apply)',
      '    # cloud-leave performs assignment drain then host stop and must refuse residual podPool work.',
      ...(cloud ? [`    zsh ${tool('cloud-leave')} "$MACHINE"`] : []),
      '    # After drain/stop succeeds, OP removes host-caps.tsv and podPool entries.',
      `    confirm_manual_step ${shellQuote(`UNLISTED:${machine}`)} ${shellQuote('After removing host-caps/podPool entries following drain and stop,')}`,
      `    echo ${shellQuote(`On the target machine, clear local membership with: eln machine leave --role ${role ?? 'worker'} --yes`)}`);
    lines.push('    ;;', '  rollback)',
      '    # Restore reviewed host-caps.tsv/podPool entries before re-admission.',
      `    confirm_manual_step ${shellQuote(`RESTORED:${machine}:${role ?? 'worker'}:${capacity ?? ''}`)} ${shellQuote('After restoring host-caps/podPool entries,')}`,
      ...(cloud && capacity !== undefined ? [`    zsh ${tool('cloud-join')} "$MACHINE" --caps "$CAPACITY_GIB"`] :
        ['    echo "OP: restore reviewed host-caps.tsv/podPool entries and approved membership for $MACHINE" >&2; exit 2']),
      '    ;;', '  *) echo "usage: $0 [apply|rollback]" >&2; exit 2 ;;', 'esac');
  }
  lines.push('');
  writeFileSync(path, `${lines.join('\n')}\n`, { mode: 0o700, flag: 'wx' });
  chmodSync(path, 0o700);
}

function declaredRoles(machine: string, root?: string): MachineGridRole[] {
  const profile = readMachineProfile(root);
  if (!profile || profile.id !== machine) return [];
  return profile.duties.filter(isRole);
}

function checkNode(machine: string, platform: MachineSetupPlatform, run: NonNullable<MachineMembershipDeps['run']>, hostPlatform: NodeJS.Platform): ProcessResult {
  if (platform === 'wsl' && hostPlatform === 'win32') {
    const path = run('wsl.exe', ['wslpath', '-u', NODE_SETUP_SCRIPT]);
    if (path.status !== 0) return { status: path.status, ...(path.errorCode ? { errorCode: path.errorCode } : {}) };
    if (!path.stdout?.trim()) return { status: 1, errorCode: 'EMPTY_WSL_PATH' };
    return run('wsl.exe', ['bash', path.stdout.trim(), machine, '--check']);
  }
  return run('bash', [NODE_SETUP_SCRIPT, machine, '--check']);
}

export function registerMachineMembershipCommands(machine: Command, deps: MachineMembershipDeps = {}): void {
  const output = deps.output ?? console;
  const setExitCode = deps.setExitCode ?? ((code: number) => { process.exitCode = code; });
  const machineName = deps.machine ?? (() => resolveMachineName({ root: deps.root }).machine);
  const platform = deps.platform ?? currentPlatform;
  const hostPlatform = deps.hostPlatform ?? process.platform;
  const run = deps.run ?? defaultRun;
  const setup = deps.setup ?? defaultSetup;
  const now = deps.now ?? (() => new Date());

  const join = machine.command('join')
    .description('Plan or apply local machine setup and grid role checks; operator-owned fleet settings are never changed.')
    .requiredOption('--role <role>', 'headquarters, gate, pod, or worker')
    .option('--profile <profile>', 'default, developer, or headquarters', 'default')
    .option('--platform <platform>', 'macos, linux, or wsl; defaults to this machine')
    .option('--capture <file>', 'captured source profile for setup apply')
    .option('--cloud', 'show the operator-owned cloud join command without running it')
    .option('--capacity <n>', 'requested capacity for the operator to review')
    .option('--emit-script <file>', 'write the OP-only registration script and its rollback path')
    .option('--yes', 'apply setup, Tailscale login start, node check, and local role declaration')
    .option('--json', 'structured plan and result')
    .allowExcessArguments(false)
    .action((options: { role: string; profile: string; platform?: string; capture?: string; cloud?: boolean; capacity?: string; emitScript?: string; yes?: boolean; json?: boolean }) => {
      try {
        if (!isRole(options.role)) throw new Error('role must be headquarters, gate, pod, or worker');
        if (!['default', 'developer', 'headquarters'].includes(options.profile)) throw new Error('profile must be default, developer, or headquarters');
        const currentMachine = machineName();
        if (!MACHINE_NAME.test(currentMachine)) throw new Error('current machine name is invalid');
        const selectedPlatform = options.platform ?? platform();
        if (!isPlatform(selectedPlatform)) throw new Error('platform must be macos, linux, or wsl');
        const capacity = options.capacity === undefined ? undefined : Number(options.capacity);
        if (capacity !== undefined && (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 1024)) throw new Error('capacity must be an integer from 1 to 1024');
        if (options.yes && capacity === undefined) throw new Error('--capacity <GiB> is required to record a resource ceiling when applying join');
        if (options.emitScript) {
          if (options.yes) throw new Error('--emit-script and --yes are separate operations; emit the OP plan first, then apply locally with --yes');
          if (!options.cloud || capacity === undefined) throw new Error('--emit-script requires --cloud and --capacity <GiB> so the OP bundle is executable and bounded');
          writeOperatorScript(options.emitScript, 'join', currentMachine, options.role, options.cloud === true, capacity);
          output.log(`machine join · OP script written · ${options.emitScript} · apply|rollback`);
          setExitCode(0);
          return;
        }
        const profile = options.profile as MachineSetupProfile;
        const plan = {
          kind: 'machine-join-plan' as const,
          machine: currentMachine,
          role: options.role,
          profile,
          platform: selectedPlatform,
          dryRun: options.yes !== true,
          localActions: [
            `machine setup apply --profile ${profile} --platform ${selectedPlatform} --yes`,
            `install Tailscale from its approved platform source if missing; ${tailscaleBinary(hostPlatform)} up requires user-approved login`,
            `${tailscaleBinary(hostPlatform)} status`,
            `bash scripts/fleet/node-setup.sh ${currentMachine} --check (no persistent changes; may create and remove a temporary DNS probe Pod)`,
            'record local machine duty, resource ceiling (--capacity required by --yes), and join timestamp in the product ledger',
          ],
          operatorActions: operatorJoinLines(currentMachine, options.role, options.cloud === true, capacity),
        };
        if (!options.yes) {
          if (options.json) output.log(JSON.stringify(plan, null, 2));
          else output.log([`machine join · plan · ${currentMachine} · role=${options.role} · profile=${profile} · platform=${selectedPlatform}`,
            ...plan.localActions.map(action => `local --yes: ${action}`), ...plan.operatorActions].join('\n'));
          setExitCode(0);
          return;
        }

        const setupResult = setup(profile, selectedPlatform, options.capture);
        if (!setupResult.applied || setupResult.failures.length > 0) {
          output.error('machine join blocked · setup apply failed; local role not declared');
          setExitCode(1);
          return;
        }
        const status = run(tailscaleBinary(hostPlatform), ['status', '--json']);
        if (!tailscaleIsRunning(status)) {
          const login = run(tailscaleBinary(hostPlatform), ['up'], true);
          if (login.status !== 0 || !tailscaleIsRunning(run(tailscaleBinary(hostPlatform), ['status', '--json']))) {
            output.error('machine join pending · Tailscale login needs user approval; local role not declared');
            setExitCode(1);
            return;
          }
        }
        const node = checkNode(currentMachine, selectedPlatform, run, hostPlatform);
        if (node.status !== 0) {
          output.error(`machine join blocked · node-setup --check failed (exit ${node.status ?? node.errorCode ?? 'unknown'}); local role not declared`);
          setExitCode(1);
          return;
        }
        const joinedAt = now().toISOString();
        addLocalRole(currentMachine, options.role, capacity!, joinedAt, deps.root);
        const lines = [`machine join · applied · ${currentMachine} · role=${options.role} · setup ok · tailscale ok · node check ok`,
          ...plan.operatorActions];
        if (options.json) output.log(JSON.stringify({ ...plan, dryRun: false, applied: true, operatorActions: plan.operatorActions }, null, 2));
        else output.log(lines.join('\n'));
        setExitCode(0);
      } catch (error) {
        output.error(error instanceof Error ? error.message : 'machine join failed');
        setExitCode(1);
      }
    });

  const leave = machine.command('leave')
    .description('Check this machine and print operator-owned drain/leave steps; never changes fleet admission or stops a cluster.')
    .option('--role <role>', 'grid role to describe; defaults to roles declared on this machine')
    .option('--platform <platform>', 'macos, linux, or wsl; defaults to this machine')
    .option('--cloud', 'show the operator-owned cloud leave command without running it')
    .option('--yes', 'run local Tailscale/node checks and remove the product-owned membership record')
    .option('--emit-script <file>', 'write the ordered OP-only drain/stop plan and rollback path')
    .option('--json', 'structured plan and result')
    .allowExcessArguments(false)
    .action((options: { role?: string; platform?: string; cloud?: boolean; emitScript?: string; yes?: boolean; json?: boolean }) => {
      try {
        const currentMachine = machineName();
        if (!MACHINE_NAME.test(currentMachine)) throw new Error('current machine name is invalid');
        const selectedPlatform = options.platform ?? platform();
        if (!isPlatform(selectedPlatform)) throw new Error('platform must be macos, linux, or wsl');
        if (options.role !== undefined && !isRole(options.role)) throw new Error('role must be headquarters, gate, pod, or worker');
        const localProfile = readMachineProfile(deps.root);
        const roles = options.role ? [options.role] : localProfile?.membership ? [localProfile.membership.role] : declaredRoles(currentMachine, deps.root);
        if (options.role && localProfile?.membership && options.role !== localProfile.membership.role) {
          throw new Error(`requested leave role ${options.role} differs from local membership ${localProfile.membership.role}`);
        }
        if (options.emitScript) {
          if (options.yes) throw new Error('--emit-script and --yes are separate operations; emit the OP plan first, then apply locally with --yes');
          if (!options.cloud) throw new Error('--emit-script requires --cloud to include the OP leave command');
          if (!localProfile?.membership) throw new Error('--emit-script requires a local membership record for a bounded rollback');
          writeOperatorScript(options.emitScript, 'leave', currentMachine, localProfile.membership.role, options.cloud === true,
            localProfile.membership.resourceCapGiB);
          output.log(`machine leave · OP script written · ${options.emitScript} · apply|rollback`);
          setExitCode(0);
          return;
        }
        const plan = {
          kind: 'machine-leave-plan' as const,
          machine: currentMachine,
          roles,
          platform: selectedPlatform,
          dryRun: options.yes !== true,
          localActions: ['tailscale status (read only)', `bash scripts/fleet/node-setup.sh ${currentMachine} --check (no persistent changes; may create and remove a temporary DNS probe Pod)`, 'remove this machine membership record from the product ledger'],
          operatorActions: operatorLeaveLines(currentMachine, roles, options.cloud === true),
          changed: { productMembership: false, role: false, resourceCap: false, hostCaps: false, podPool: false, cluster: false },
        };
        if (!options.yes) {
          if (options.json) output.log(JSON.stringify(plan, null, 2));
          else output.log([`machine leave · plan · ${currentMachine} · roles=${roles.join(',') || 'none'} · read only`,
            ...plan.localActions.map(action => `local --yes: ${action}`), ...plan.operatorActions].join('\n'));
          setExitCode(0);
          return;
        }
        const tailscale = run(tailscaleBinary(hostPlatform), ['status', '--json']);
        const node = checkNode(currentMachine, selectedPlatform, run, hostPlatform);
        if (!tailscaleIsRunning(tailscale) || node.status !== 0) {
          output.error(`machine leave blocked · tailscale=${tailscaleIsRunning(tailscale) ? 'ok' : 'unavailable'} · node-setup --check=${node.status === 0 ? 'ok' : 'failed'}`);
          const result = { ...plan, dryRun: false, checked: { tailscale: tailscaleIsRunning(tailscale), nodeSetup: node.status === 0 }, membershipRemoved: false };
          if (options.json) output.log(JSON.stringify(result, null, 2));
          setExitCode(1);
          return;
        }
        const membershipRemoved = removeLocalMembership(currentMachine, deps.root);
        const result = { ...plan, dryRun: false, changed: { ...plan.changed, productMembership: membershipRemoved },
          checked: { tailscale: true, nodeSetup: true }, membershipRemoved };
        if (options.json) output.log(JSON.stringify(result, null, 2));
        else output.log([`machine leave · local checks · ${currentMachine} · tailscale=${tailscaleIsRunning(tailscale) ? 'ok' : 'unavailable'} · node=${node.status === 0 ? 'ok' : 'unavailable'}`,
          ...plan.operatorActions, 'local role, host-caps, podPool, and cluster unchanged'].join('\n'));
        setExitCode(0);
      } catch (error) {
        output.error(error instanceof Error ? error.message : 'machine leave failed');
        setExitCode(1);
      }
    });
}
