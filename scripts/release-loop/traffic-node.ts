#!/usr/bin/env bun
import { spawnSync } from 'node:child_process';
import { debug } from '../../src/debug/log.js';
import { SPAWN_SYNC_MAX_BUFFER } from '../../src/util/spawn-sync-output.js';
import { releaseLoopConfig, resolveRunVersion } from './unattended-release.js';
import { errorResult, finishNode, readGraphContext } from './node-verdict.js';
import { isPrereleaseKind, type PrereleaseKind } from './release-version.js';
import { restoreTrafficPrep, runTrafficPrep, runTrafficPrepForRun, trafficPrepQuickpassHint, TRAFFIC_NOT_PREPPED, TRAFFIC_PREP_HOLD_POLL_MS,
  TRAFFIC_PREP_NODE_ID, type TrafficPrepDeps, type TrafficPrepResult } from './traffic-prep.js';
import { COUNTDOWN_LONG_HOLD_NOTICE_MS } from './release-readiness.js';
import { applyReleaseTrafficEvent, trafficOptionsFromConfig, type ReleaseTrafficEvent, type TrafficTransitionOptions } from './traffic-transition.js';

const EVENTS: Record<string, ReleaseTrafficEvent> = {
  'traffic-cut-start': 'cut-start',
  'traffic-gate-passed': 'gate-passed',
  'traffic-npm-published': 'npm-published',
  'traffic-verify-complete': 'verify-complete',
  'traffic-failed-restore': 'failed',
};

export interface TrafficNodeDeps {
  options?: TrafficTransitionOptions;
  report?: (body: string) => void;
}

function reportFailure(body: string): void {
  const result = spawnSync('eln', ['msg', 'post', '--from', 'MK', '--to', 'OP', '--kind', 'report', '--body', body], { encoding: 'utf8', timeout: 10_000, maxBuffer: SPAWN_SYNC_MAX_BUFFER });
  if (result.status !== 0 || result.error) process.stderr.write(`traffic OP mail failed: ${result.stderr || result.error || result.status}\n`);
}

/** Traffic transitions are warning-only for the release graph, but their node result remains truthful. */
export async function runTrafficNode(node = process.argv[2], env: NodeJS.ProcessEnv = process.env, deps: TrafficNodeDeps = {}): Promise<number> {
  let version = '';
  let runId = '';
  try {
    const context = readGraphContext(env);
    version = context.input.version;
    runId = context.runId ?? '';
    const event = EVENTS[node ?? ''];
    if (!event || context.nodeId !== node) throw new Error(`traffic node context mismatch: ${node ?? 'missing'}`);
    const options = deps.options ?? trafficOptionsFromConfig(env, releaseLoopConfig());
    if (!options.trafficFile) {
      const summary = `traffic-file-unset: ${event} skipped because trafficFile is not configured`;
      debug.log('release-loop.traffic', 'traffic-file-unset', { runId, version, event, node, reason: summary });
      (deps.report ?? reportFailure)(`RELEASE-POSTPUB-TRAFFIC ${version} ${runId || 'unknown'} ${node} ${summary}. Release traffic was not changed.`);
      return finishNode(node!, version, { outcome: 'fail', verdict: 'fail', summary });
    }
    const result = await applyReleaseTrafficEvent(context, event, options);
    // Replaying the terminal restore after this run already restored its pre-cut traffic is a successful no-op.
    const alreadyRestored = event === 'failed' && result.reason === 'already-restored';
    const applied = result.applied || alreadyRestored;
    if (!applied) {
      const consequence = event === 'failed' && result.reason === 'published-keeps-full'
        ? 'npm 발행은 완료됐으므로 전체 트래픽을 유지합니다. 후속 발행 단계 실패를 확인하세요.'
        : event === 'verify-complete' || event === 'npm-published'
          ? '발행은 성공했으나 전체 트래픽 전환이 적용되지 않았습니다.'
          : event === 'failed' ? '컷 전 트래픽 복귀가 적용되지 않았습니다.'
            : event === 'cut-start' ? '컷은 시작했으나 gate 모드 전환이 적용되지 않았습니다.'
              : 'gate는 성공했으나 트래픽 감속이 적용되지 않았습니다.';
      (deps.report ?? reportFailure)(`RELEASE-POSTPUB-TRAFFIC ${version} ${runId || 'unknown'} ${node} 무시 — ${result.reason ?? 'traffic state unchanged'}. ${consequence}`);
    }
    return finishNode(node!, version, { outcome: applied ? 'ok' : 'fail', verdict: applied ? 'pass' : 'fail',
      summary: `${event} ${alreadyRestored ? 'already-restored' : applied ? 'applied' : result.reason ?? 'ignored'}` });
  } catch (error) {
    const detail = errorResult(error).summary;
    const isLockTimeout = detail.startsWith('traffic lock timeout:');
    const failure = isLockTimeout ? `traffic-lock-timeout · stale 의심 경로 ${detail.slice('traffic lock timeout:'.length).trim()}` : detail;
    debug.log('release-loop.traffic', 'non-blocking-failure', { node: node ?? 'missing', version, reason: detail });
    (deps.report ?? reportFailure)(`RELEASE-POSTPUB-TRAFFIC ${version || 'unknown'} ${runId || 'unknown'} ${node ?? 'unknown'} 실패 — ${failure}. 릴리스 판정은 계속 진행한다.`);
    return finishNode(node ?? 'traffic', version, { outcome: 'fail', verdict: 'fail', summary: `traffic transition failed; release graph continues with warning: ${failure}` });
  }
}

export interface TrafficPrepCommand { version: string; prerelease?: string; cutAt?: string; restore?: boolean }

/** origin/main HEAD at prep time — read-only; the cut commit itself does not exist before the run. */
function originMainSha(): string | null {
  // git-spawn-allow: read-only ls-remote to stamp the prep receipt.
  const result = spawnSync('git', ['ls-remote', 'origin', 'refs/heads/main'], { encoding: 'utf8', timeout: 10_000, maxBuffer: SPAWN_SYNC_MAX_BUFFER });
  const sha = result.status === 0 ? result.stdout.split(/\s+/)[0] ?? '' : '';
  return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

/**
 * RELEASE-TRAFFIC-PREP-T1H — the T-1h traffic-prep step (hand: `elanous release traffic-prep`, or
 * `bun scripts/release-loop/traffic-node.ts traffic-prep --version <v> [--prerelease rc --cut-at <iso>] [--restore]`).
 * An rc rehearsal resolves its run version (`<v>-rc.<next>`) exactly as `release run --prerelease rc` does.
 */
export async function runTrafficPrepCommand(command: TrafficPrepCommand, env: NodeJS.ProcessEnv = process.env,
  deps: TrafficPrepDeps & { resolveVersion?: (version: string, prerelease: PrereleaseKind | undefined) => string } = {}): Promise<TrafficPrepResult & { version: string }> {
  if (command.prerelease !== undefined && !isPrereleaseKind(command.prerelease)) throw new Error(`--prerelease supports rc only: ${command.prerelease}`);
  const prerelease = command.prerelease as PrereleaseKind | undefined;
  const version = (deps.resolveVersion ?? ((v, kind) => resolveRunVersion(v, kind)))(command.version, prerelease);
  const traffic = deps.traffic ?? trafficOptionsFromConfig(env, releaseLoopConfig());
  const prepDeps: TrafficPrepDeps = { ...deps, traffic, baseSha: deps.baseSha ?? originMainSha };
  const result = command.restore ? await restoreTrafficPrep(version, prepDeps)
    : await runTrafficPrep({ version, ...(command.cutAt !== undefined ? { cutAt: command.cutAt } : {}) }, prepDeps);
  return { ...result, version };
}

export interface TrafficPrepNodeDeps extends TrafficPrepDeps {
  /** Test seam: the before-window hold sleeps through this (default: a real timer). */
  sleep?: (milliseconds: number) => Promise<void>;
}

/**
 * RELEASE-TRAFFIC-PREP-T1H graph node `traffic-prep` (entry, before `cut-branch`). Inside cutAt−1h … cutAt it applies
 * the T-1h traffic control under the run id and emits the receipt path; before the window it holds until windowStart
 * (unbounded like the readiness countdown, with a notice once per cadence; never a failure); a late run (after cutAt,
 * within validUntil) still applies and records `late: true`. The manual `elanous release traffic-prep` stays the fallback.
 */
export async function runTrafficPrepNode(env: NodeJS.ProcessEnv = process.env, deps: TrafficPrepNodeDeps = {}): Promise<number> {
  let version = '';
  try {
    const context = readGraphContext(env);
    version = context.input.version;
    if (context.nodeId !== TRAFFIC_PREP_NODE_ID) throw new Error(`traffic node context mismatch: ${TRAFFIC_PREP_NODE_ID}`);
    if (!context.runId) throw new Error('traffic-prep node requires the graph runId');
    const runId = context.runId;
    const traffic = deps.traffic ?? trafficOptionsFromConfig(env, releaseLoopConfig());
    const prepDeps: TrafficPrepDeps = { ...deps, traffic, baseSha: deps.baseSha ?? originMainSha };
    const now = deps.now ?? (() => new Date());
    const sleep = deps.sleep ?? ((milliseconds: number) => new Promise<void>((done) => setTimeout(done, milliseconds)));
    let holdSince: number | null = null;
    let notifiedAt: number | null = null;
    for (;;) {
      const result = await runTrafficPrepForRun({ version, runId }, prepDeps);
      if (result.ok) {
        const { receipt } = result;
        return finishNode(TRAFFIC_PREP_NODE_ID, version, { outcome: 'ok', verdict: 'pass',
          summary: `traffic-prep ${receipt.trafficResult}${receipt.late ? ' (late run)' : ''}${result.reused ? ' · reused receipt' : ''} · ${result.receiptPath}`,
          receiptPath: result.receiptPath, cutAt: receipt.cutAt, appliedAt: receipt.appliedAt, late: receipt.late === true,
          reused: result.reused, prepRunId: receipt.prepRunId, ...(receipt.takenOverFrom ? { takenOverFrom: receipt.takenOverFrom } : {}),
          ...(holdSince !== null ? { heldMs: now().getTime() - holdSince } : {}) });
      }
      if (result.reason !== 'before-window') {
        return finishNode(TRAFFIC_PREP_NODE_ID, version, { outcome: 'fail', verdict: 'fail', receiptPath: result.receiptPath,
          summary: `${TRAFFIC_NOT_PREPPED}(${result.reason}): ${result.detail} — ${trafficPrepQuickpassHint(version)}` });
      }
      // Before the window is a hold, not a failure: wait for windowStart (re-evaluated each poll — the schedule may move).
      const instant = now().getTime();
      holdSince ??= instant;
      if (notifiedAt === null || instant - notifiedAt >= COUNTDOWN_LONG_HOLD_NOTICE_MS) {
        notifiedAt = instant;
        debug.log('release-loop.traffic-prep', 'hold-before-window', { version, runId, cutAt: result.cutAt, windowStart: result.windowStart,
          since: new Date(holdSince).toISOString(), heldMs: instant - holdSince });
      }
      await sleep(Math.max(1, Math.min(TRAFFIC_PREP_HOLD_POLL_MS, Date.parse(result.windowStart) - instant)));
    }
  } catch (error) {
    const failure = errorResult(error);
    debug.log('release-loop.traffic-prep', 'node-error', { version, reason: failure.summary });
    return finishNode(TRAFFIC_PREP_NODE_ID, version, failure);
  }
}

function prepArgs(args: string[]): TrafficPrepCommand {
  const command: Partial<TrafficPrepCommand> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json') continue;
    if (arg === '--restore') { command.restore = true; continue; }
    if (arg === '--version' && args[i + 1]) { command.version = args[++i]!; continue; }
    if (arg === '--prerelease' && args[i + 1]) { command.prerelease = args[++i]!; continue; }
    if (arg === '--cut-at' && args[i + 1]) { command.cutAt = args[++i]!; continue; }
    throw new Error(`unknown or incomplete argument: ${arg}`);
  }
  if (!command.version) throw new Error('usage: traffic-node.ts traffic-prep --version <x.y.z> [--prerelease rc] [--cut-at <iso>] [--restore]');
  return command as TrafficPrepCommand;
}

if (import.meta.main) {
  if (process.argv[2] === 'traffic-prep') {
    try {
      const result = await runTrafficPrepCommand(prepArgs(process.argv.slice(3)));
      console.log(JSON.stringify(result));
      process.exitCode = result.ok ? 0 : 1;
    } catch (error) {
      console.log(JSON.stringify({ ok: false, reason: 'error', detail: errorResult(error).summary }));
      process.exitCode = 1;
    }
  } else process.exitCode = await runTrafficNode();
}
