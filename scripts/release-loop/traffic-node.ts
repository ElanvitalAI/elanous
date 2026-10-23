#!/usr/bin/env bun
import { spawnSync } from 'node:child_process';
import { debug } from '../../src/debug/log.js';
import { SPAWN_SYNC_MAX_BUFFER } from '../../src/util/spawn-sync-output.js';
import { releaseLoopConfig } from './unattended-release.js';
import { errorResult, finishNode, readGraphContext } from './node-verdict.js';
import { applyReleaseTrafficEvent, trafficOptionsFromConfig, type ReleaseTrafficEvent, type TrafficTransitionOptions } from './traffic-transition.js';

const EVENTS: Record<string, ReleaseTrafficEvent> = {
  'traffic-gate-passed': 'gate-passed',
  'traffic-verify-complete': 'verify-complete',
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
    if (!result.applied) {
      const consequence = event === 'verify-complete'
        ? '릴리스 검증은 성공했으나 트래픽 복귀가 적용되지 않았습니다.'
        : 'gate는 성공했으나 트래픽 감속이 적용되지 않았습니다.';
      (deps.report ?? reportFailure)(`RELEASE-POSTPUB-TRAFFIC ${version} ${runId || 'unknown'} ${node} 무시 — ${result.reason ?? 'traffic state unchanged'}. ${consequence}`);
    }
    return finishNode(node!, version, { outcome: 'ok', verdict: 'pass', summary: `${event} ${result.applied ? 'applied' : result.reason ?? 'ignored'}` });
  } catch (error) {
    const detail = errorResult(error).summary;
    const isLockTimeout = detail.startsWith('traffic lock timeout:');
    const failure = isLockTimeout ? `traffic-lock-timeout · stale 의심 경로 ${detail.slice('traffic lock timeout:'.length).trim()}` : detail;
    debug.log('release-loop.traffic', 'non-blocking-failure', { node: node ?? 'missing', version, reason: detail });
    (deps.report ?? reportFailure)(`RELEASE-POSTPUB-TRAFFIC ${version || 'unknown'} ${runId || 'unknown'} ${node ?? 'unknown'} 실패 — ${failure}. 릴리스 판정은 계속 진행한다.`);
    return finishNode(node ?? 'traffic', version, { outcome: 'fail', verdict: 'fail', summary: `traffic transition failed; release graph continues with warning: ${failure}` });
  }
}

if (import.meta.main) process.exitCode = await runTrafficNode();
