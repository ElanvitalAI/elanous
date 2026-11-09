#!/usr/bin/env bun
import { existsSync, readFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { errorResult, finishNode, readGraphContext, type GraphContext } from './node-verdict.js';

export const HAND_RESPONSE_ACTIONS = [
  'rla-release-autostart', 'rla-train-worker-restart', 'cut-append', 'rla-release-recover', 'rla-rehearsal-retry',
  'rla-cloud-join', 'rla-cloud-leave', 'rla-focused-verify', 'rla-rail-now', 'rla-nexus-restart', 'rla-nexus-build',
] as const;
export type HandResponseAction = typeof HAND_RESPONSE_ACTIONS[number];

export interface HandResponseCommand {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  summary: string;
  mutatesState: boolean;
  detached?: boolean;
  /** A missing approval returns a plan without invoking the command. */
  approved: boolean;
  /** Used only by the rehearsal stamp retry action. */
  archiveStamp?: { source: string; destination: string };
}

export interface HandResponseResult { status: number | null; stdout: string; stderr: string }
export type HandResponseRunner = (command: string, args: string[], options?: { cwd?: string; env?: NodeJS.ProcessEnv; detached?: boolean }) => HandResponseResult | Promise<HandResponseResult>;
export interface HandResponseDeps {
  run?: HandResponseRunner;
  archiveStamp?: (source: string, destination: string) => void;
  restoreStamp?: (source: string, destination: string) => void;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  uid?: number;
}

const HOST = /^(?:aws[1-3]|gcp[1-3]|node-c|minim5|node-b|host-e-wsl|elangram-wsl|mbp)$/;
const SHA = /^[0-9a-f]{40}$/i;
const SAFE_REASON = /^[a-z0-9][a-z0-9-]{0,39}$/i;
const SAFE_RELATIVE = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[a-zA-Z0-9._/-]+$/;

function input(context: GraphContext): Record<string, unknown> {
  return context.nodeInput ?? {};
}

function requiredString(values: Record<string, unknown>, key: string, pattern?: RegExp): string {
  const value = values[key];
  if (typeof value !== 'string' || !value.trim() || (pattern && !pattern.test(value))) throw new Error(`${key} is missing or invalid`);
  return value.trim();
}

function toolPath(name: string, env: NodeJS.ProcessEnv): string {
  const root = env.ELANOUS_HQ_OP_TOOLS_DIR?.trim() || join(homedir(), 'elanous-hq/seat-state/OP/tools');
  return resolve(root, name);
}

function approvalFor(action: HandResponseAction, values: Record<string, unknown>): boolean {
  return values.apply === true && values.approvedAction === action;
}

/** Build the exact shell-free operation for a release-graph node. Never runs it. */
export function planHandResponseAction(action: HandResponseAction, context: GraphContext, env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform, uid = typeof process.getuid === 'function' ? process.getuid() : 0): HandResponseCommand {
  if (!HAND_RESPONSE_ACTIONS.includes(action)) throw new Error(`unknown hand-response action: ${action}`);
  if (context.nodeId !== action) throw new Error(`graph node mismatch: expected ${action}, received ${context.nodeId ?? 'missing'}`);
  const values = input(context);
  const approved = approvalFor(action, values);
  const tools = (name: string) => toolPath(name, env);
  const eln = env.ELANOUS_BIN?.trim() || 'eln';

  switch (action) {
    case 'rla-release-autostart':
      return { command: eln, args: ['release', 'auto-start', ...(approved ? ['--apply'] : []), '--json'],
        summary: approved ? 'launch scheduled release run' : 'preview scheduled release auto-start', mutatesState: true, approved };
    case 'rla-train-worker-restart': {
      const host = requiredString(values, 'host', HOST);
      const slot = requiredString(values, 'slot', /^[1-9][0-9]?$/);
      const stopAt = requiredString(values, 'stopAt', /^\d{12}$/);
      if (!approved) return { command: 'perl', args: [], summary: `plan restart ${host}/${slot} with STOP_AT=${stopAt}`, mutatesState: true, approved };
      const worker = tools('train-auto-loop.sh');
      return { command: 'perl', args: ['-e', 'setpgrp(0,0); exec @ARGV', 'zsh', worker],
        env: { ...env, HOST: host, TRAIN_SLOT: slot, TRAIN_WORKER_MODE: '1', STOP_AT: stopAt,
          MIN_PRS: '1', MAX_PRS: '4', SHARDS: String(values.shards ?? '1'), RETRY_HOST: host }, detached: true,
        summary: `restart train worker ${host}/${slot} through train-auto-loop.sh`, mutatesState: true, approved };
    }
    case 'rla-release-recover': {
      const runId = requiredString(values, 'runId', /^[a-zA-Z0-9/_-]{1,120}$/);
      const picks = values.pickShas;
      if (!Array.isArray(picks) || picks.length === 0 || picks.some((sha) => typeof sha !== 'string' || !SHA.test(sha))) {
        throw new Error('pickShas must contain one or more full commit SHAs');
      }
      return { command: eln, args: ['release', 'recover', '--run', runId, '--pick', ...picks as string[], '--json'],
        summary: approved ? `append main fixes and resume release run ${runId}` : `preview recover for release run ${runId}`,
        mutatesState: true, approved };
    }
    case 'cut-append': {
      const version = requiredString({ ...values, version: values.version ?? context.input.version }, 'version', /^\d+\.\d+\.\d+$/);
      const picks = values.pickShas;
      if (!Array.isArray(picks) || picks.length === 0 || picks.some((sha) => typeof sha !== 'string' || !SHA.test(sha)))
        throw new Error('pickShas must contain one or more full commit SHAs');
      return { command: eln, args: ['release', 'cut-branch', '--version', version, '--append',
        ...picks.flatMap((sha) => ['--pick', sha as string]), ...(!approved ? ['--dry-run'] : []), '--json'],
        summary: approved ? `append ${picks.length} landed repair commit(s) to release/${version}` : `preview cut append for release/${version}`,
        mutatesState: true, approved };
    }
    case 'rla-rehearsal-retry': {
      const version = requiredString(values, 'version', /^\d+\.\d+\.\d+$/);
      const step = requiredString(values, 'step', /^[a-z0-9][a-z0-9-]{0,63}$/i);
      const reason = requiredString(values, 'reason', SAFE_REASON);
      const root = resolve(env.ELANOUS_STATE_DIR || join(homedir(), '.elanous'));
      const source = join(root, 'release', version, 'rehearsal', `${step}.json`);
      let destination = `${source}.${reason}`;
      for (let suffix = 2; existsSync(destination); suffix++) destination = `${source}.${reason}.${suffix}`;
      if (!source.startsWith(`${root}/`) || !destination.startsWith(`${root}/`)) throw new Error('stamp path escaped release state root');
      return { command: eln, args: ['release', 'rehearsal', 'tick', ...(approved ? ['--apply'] : []), '--json'],
        summary: approved ? `archive ${step} rehearsal stamp and retry the scheduled tick` : `plan archival of ${step} rehearsal stamp`,
        mutatesState: true, approved, archiveStamp: { source, destination } };
    }
    case 'rla-cloud-join':
    case 'rla-cloud-leave': {
      const host = requiredString(values, 'host', HOST);
      const script = action === 'rla-cloud-join' ? 'cloud-join.sh' : 'cloud-leave.sh';
      return { command: 'zsh', args: [tools(script), host, ...(!approved ? ['--dry-run'] : [])],
        summary: `${approved ? 'run' : 'preview'} ${script} for ${host}`, mutatesState: true, approved };
    }
    case 'rla-focused-verify': {
      const host = requiredString(values, 'host', HOST);
      if (host !== 'aws1') throw new Error('K-OP-148 focused verification must use aws1');
      const remoteRoot = requiredString(values, 'remoteCommandRoot', /^\/[A-Za-z0-9._/-]+$/);
      const files = values.introducedFiles;
      if (!Array.isArray(files) || files.length === 0 || files.some((file) => typeof file !== 'string' || !SAFE_RELATIVE.test(file) || !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file))) {
        throw new Error('introducedFiles must be a non-empty list of safe test paths from gate-verdict introduced');
      }
      const command = `cd ${remoteRoot} && bun test -- ${files.join(' ')}`;
      return { command: 'ssh', args: ['-o', 'BatchMode=yes', host, command],
        summary: `run introduced test files on ${host}: ${files.join(', ')}`, mutatesState: false, approved: true };
    }
    case 'rla-rail-now': {
      const hosts = values.hosts;
      if (!Array.isArray(hosts) || hosts.length === 0 || hosts.some((host) => typeof host !== 'string' || !HOST.test(host))) {
        throw new Error('hosts must be a non-empty allowlisted host-name list');
      }
      if (!approved) return { command: 'zsh', args: [], summary: `plan rail-now for ${hosts.join(', ')}`, mutatesState: true, approved };
      return { command: 'zsh', args: [tools('rail-now.sh')], env: { ...env, RAIL_HOSTS: hosts.join(' ') },
        summary: `run rail-now for explicit hosts: ${hosts.join(', ')}`, mutatesState: true, approved };
    }
    case 'rla-nexus-restart':
      if (platform !== 'darwin') throw new Error('Nexus launchd restart requires macOS');
      return { command: 'launchctl', args: ['kickstart', '-k', `gui/${uid}/com.elanous.nexus`],
        summary: approved ? 'restart Nexus launchd job' : 'plan Nexus launchd restart', mutatesState: true, approved };
    case 'rla-nexus-build':
      if (values.staticExportChanged !== true) throw new Error('nexus build is only valid when static export inputs changed');
      return { command: eln, args: ['nexus', 'build'], summary: approved ? 'build the static Nexus export' : 'plan Nexus static export build',
        mutatesState: true, approved };
  }
}

export async function runDetachedHandResponseCommand(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
  spawnChild: typeof spawn = spawn,
  readiness: { timeoutMs?: number; readWorkerPid?: () => string } = {}): Promise<HandResponseResult> {
  return await new Promise<HandResponseResult>((resolve) => {
    const child: ChildProcess = spawnChild(command, args, { cwd: options.cwd, env: options.env, detached: true, stdio: 'ignore' });
    let settled = false;
    let readyTimer: ReturnType<typeof setInterval> | undefined;
    const finish = (result: HandResponseResult, unref = false) => {
      if (settled) return;
      settled = true;
      if (readyTimer) clearInterval(readyTimer);
      if (unref) child.unref();
      resolve(result);
    };
    const failAndStopChild = (result: HandResponseResult) => {
      try { child.kill('SIGTERM'); } catch { /* unref below still releases the node process */ }
      child.unref();
      finish(result);
    };
    child.once('error', (error) => finish({ status: 1, stdout: '', stderr: String(error) }));
    child.once('exit', (code, signal) => finish({ status: 1, stdout: '', stderr: `worker exited before ready (code=${String(code)}, signal=${String(signal)})` }));
    child.once('spawn', () => {
      const env = options.env ?? process.env;
      const expectedPid = child.pid;
      const pidPath = join(homedir(), 'elanous-hq/seat-state/OP/train-manager/workers', `${env.HOST ?? 'node-b'}-${env.TRAIN_SLOT ?? '1'}.pid`);
      const readWorkerPid = readiness.readWorkerPid ?? (() => existsSync(pidPath) ? readFileSync(pidPath, 'utf8').trim() : '');
      const startedAt = Date.now();
      const pollReady = () => {
        let recordedPid: string;
        try { recordedPid = readWorkerPid(); }
        catch (error) {
          failAndStopChild({ status: 1, stdout: '', stderr: `worker readiness PID marker read failed: ${String(error)}` });
          return;
        }
        if (expectedPid !== undefined && recordedPid === String(expectedPid)) {
          finish({ status: 0, stdout: `worker ready pid=${expectedPid}`, stderr: '' }, true);
        } else if (Date.now() - startedAt >= (readiness.timeoutMs ?? 30_000)) {
          failAndStopChild({ status: 1, stdout: '', stderr: `worker readiness timeout; expected pid=${String(expectedPid)} recorded pid=${recordedPid || 'missing'}` });
        }
      };
      pollReady();
      if (!settled) readyTimer = setInterval(pollReady, 100);
    });
  });
}

export const runHandResponseCommand: HandResponseRunner = async (command, args, options = {}) => {
  if (options.detached) return runDetachedHandResponseCommand(command, args, options);
  const result = spawnSync(command, args, { cwd: options.cwd, env: options.env, encoding: 'utf8', timeout: 1_800_000, maxBuffer: 64 * 1024 * 1024 });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr || (result.error ? String(result.error) : '') };
};

export async function runHandResponseNode(actionName = process.argv[2], env: NodeJS.ProcessEnv = process.env,
  deps: HandResponseDeps = {}): Promise<number> {
  let version = '';
  try {
    if (!HAND_RESPONSE_ACTIONS.includes(actionName as HandResponseAction)) throw new Error(`unknown hand-response action: ${actionName ?? 'missing'}`);
    const action = actionName as HandResponseAction;
    const context = readGraphContext(env);
    version = context.input.version;
    const plan = planHandResponseAction(action, context, deps.env ?? env, deps.platform, deps.uid);
    if (plan.mutatesState && !plan.approved) {
      finishNode(action, version, { outcome: 'ok', verdict: 'pass', summary: `plan-only: ${plan.summary}; apply requires nodeInput.apply=true and nodeInput.approvedAction=${action}` });
      return 0;
    }
    if (plan.archiveStamp && plan.approved) {
      if (deps.archiveStamp) deps.archiveStamp(plan.archiveStamp.source, plan.archiveStamp.destination);
      else {
        if (!existsSync(plan.archiveStamp.source)) throw new Error(`rehearsal stamp not found: ${plan.archiveStamp.source}`);
        if (existsSync(plan.archiveStamp.destination)) throw new Error(`rehearsal stamp archive already exists: ${plan.archiveStamp.destination}`);
        renameSync(plan.archiveStamp.source, plan.archiveStamp.destination);
      }
    }
    let result: HandResponseResult;
    try {
      result = await (deps.run ?? runHandResponseCommand)(plan.command, plan.args, { cwd: plan.cwd, env: plan.env, detached: plan.detached });
    } catch (error) {
      if (plan.archiveStamp && plan.approved) {
        if (deps.restoreStamp) deps.restoreStamp(plan.archiveStamp.source, plan.archiveStamp.destination);
        else if (!existsSync(plan.archiveStamp.source) && existsSync(plan.archiveStamp.destination)) renameSync(plan.archiveStamp.destination, plan.archiveStamp.source);
      }
      throw error;
    }
    if (result.status !== 0 && plan.archiveStamp && plan.approved) {
      if (deps.restoreStamp) deps.restoreStamp(plan.archiveStamp.source, plan.archiveStamp.destination);
      else if (!existsSync(plan.archiveStamp.source) && existsSync(plan.archiveStamp.destination)) renameSync(plan.archiveStamp.destination, plan.archiveStamp.source);
    }
    if (result.stderr) process.stderr.write(result.stderr);
    const ok = result.status === 0;
    finishNode(action, version, { outcome: ok ? 'ok' : 'fail', verdict: ok ? 'pass' : 'fail', summary: `${plan.summary} ${ok ? 'completed' : `failed (exit ${String(result.status)})`}`,
      ...(ok ? {} : { tail: result.stderr.slice(-4000) || result.stdout.slice(-4000) }) });
    return ok ? 0 : 1;
  } catch (error) {
    finishNode(actionName ?? 'hand-response', version, errorResult(error));
    return 2;
  }
}

if (import.meta.main) process.exitCode = await runHandResponseNode();
