/** Opt-in shadow of the pinned landing typecheck and changed-file gate on a Pod Job. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runPodCommand, type RunPodCommandOptions, type PodCommandResult } from '../task-orchestrator/surfaces/pod-command-job.js';
import { redactSecretText } from '../debug/log.js';
import type { RootPlanSummary } from './pr-land-heavy-remote.js';

const SHA = /^[0-9a-f]{40}$/i;
const MARKER = 'ELANOUS_PRLAND_SHADOW';
/** Shadow evidence is optional; it must not hold a ready landing for the Pod's 45-minute deadline. */
export const LANDING_POD_SHADOW_HOST_TIMEOUT_MS = 10 * 60_000;
export const LANDING_POD_SHADOW_STATUS_UNREADABLE_MS = 60_000;

export interface LandingPodShadowInput { head: string; main: string }
export interface LandingPodShadowVerdict {
  measured: boolean;
  ok: boolean;
  rootPlan: RootPlanSummary | null;
  tscRc?: number;
  gateRc?: number;
  reason?: string;
  job?: string;
}

export function landingPodShadowScript(head: string, main: string): string {
  if (!SHA.test(head) || !SHA.test(main)) throw new Error('pod shadow: invalid head/main');
  return [
    'set -u',
    `test "$(git rev-parse HEAD)" = '${head}' || { echo '${MARKER} unmeasured source-head'; exit 2; }`,
    `git fetch origin '${main}' >/dev/null 2>&1 || { echo '${MARKER} unmeasured main-fetch'; exit 2; }`,
    `git cat-file -e '${main}^{commit}' || { echo '${MARKER} unmeasured main-missing'; exit 2; }`,
    `if [ "$(git rev-parse --is-shallow-repository)" = true ]; then git fetch --unshallow origin '${head}' >/tmp/prland-shadow-unshallow.log 2>&1 || { tail -n 12 /tmp/prland-shadow-unshallow.log; echo '${MARKER} unmeasured unshallow'; exit 2; }; fi`,
    'git -c user.name=elanous-gate -c user.email=gate@localhost -c commit.gpgsign=false merge --no-ff --no-edit ' + `'${main}'` + ` >/tmp/prland-shadow-merge.log 2>&1 || { tail -n 12 /tmp/prland-shadow-merge.log; echo '${MARKER} unmeasured merge'; exit 2; }`,
    `bun install --frozen-lockfile >/tmp/prland-shadow-install.log 2>&1 || { echo '${MARKER} unmeasured root-install'; exit 2; }`,
    `if [ -f apps/pwa/package.json ]; then (cd apps/pwa && bun install --frozen-lockfile) >/tmp/prland-shadow-pwa-install.log 2>&1 || { echo '${MARKER} unmeasured pwa-install'; exit 2; }; fi`,
    `TSC_BASE_REF='${main}' bun scripts/ci-typecheck-changed.ts --local >/tmp/prland-shadow-tsc.log 2>&1; tsc_rc=$?`,
    `bun bin/elanous.mjs self gate --changed --base '${main}' --local --shards 4 >/tmp/prland-shadow-gate.log 2>&1; gate_rc=$?`,
    `printf '${MARKER}_TSC_PLAN %s\\n' "$(grep '^\\[tsc-gate\\] root-plan ' /tmp/prland-shadow-tsc.log | tail -n 1 | sed 's/^\\[tsc-gate\\] root-plan //')"`,
    "tail -n 8 /tmp/prland-shadow-tsc.log; tail -n 8 /tmp/prland-shadow-gate.log",
    `printf '${MARKER} head=%s main=%s tsc=%s gate=%s\\n' '${head}' '${main}' "$tsc_rc" "$gate_rc"`,
    'exit 0',
  ].join('\n');
}

export async function runLandingPodShadowJob(input: LandingPodShadowInput, deps: {
  runPod?: (options: RunPodCommandOptions) => Promise<PodCommandResult>;
  readLog?: (path: string) => string;
  /** Deterministic timer seam for the host deadline. */
  armTimeout?: (onTimeout: () => void, ms: number) => () => void;
} = {}): Promise<LandingPodShadowVerdict> {
  const script = landingPodShadowScript(input.head, input.main);
  const controller = new AbortController();
  const armTimeout = deps.armTimeout ?? ((onTimeout: () => void, ms: number) => {
    const timer = setTimeout(onTimeout, ms);
    return () => clearTimeout(timer);
  });
  const disarm = armTimeout(() => {
    const reason = new Error(`pod shadow: host timeout after ${LANDING_POD_SHADOW_HOST_TIMEOUT_MS}ms`);
    controller.abort(reason);
  }, LANDING_POD_SHADOW_HOST_TIMEOUT_MS);
  let job: PodCommandResult;
  try {
    // Wait for the runner to observe abort and finish Job/Secret/lease cleanup before landing continues.
    job = await (deps.runPod ?? runPodCommand)({
      command: ['bash', '-lc', script], clone: true, source: { kind: 'commit', sha: input.head },
      returnLogs: true, deadlineSeconds: 45 * 60,
      statusUnreadableMs: LANDING_POD_SHADOW_STATUS_UNREADABLE_MS,
      hostDeadlineAtMs: Date.now() + LANDING_POD_SHADOW_HOST_TIMEOUT_MS,
      signal: controller.signal,
    });
  } finally {
    disarm();
  }
  let log: string;
  try { log = (deps.readLog ?? ((path: string) => readFileSync(path, 'utf8')))(join(job.artifactsDir, 'child.log')); }
  catch (error) {
    const detail = redactSecretText(error instanceof Error ? error.message : String(error)).slice(0, 180);
    return { measured: false, ok: false, rootPlan: null, reason: `child-log-unreadable:${detail}`, job: job.job };
  }
  const expected = `${MARKER} head=${input.head} main=${input.main} `;
  const lines = log.split(/\r?\n/);
  let markerIndex = -1;
  for (let index = lines.length - 1; index >= 0; index--) {
    if (lines[index]!.startsWith(MARKER)) { markerIndex = index; break; }
  }
  const line = markerIndex >= 0 ? lines[markerIndex] : undefined;
  if (job.exitCode !== 0 || !line?.startsWith(expected)) {
    const detail = markerIndex > 0 ? redactSecretText(lines[markerIndex - 1] ?? '').trim().slice(0, 180) : '';
    return { measured: false, ok: false, rootPlan: null, reason: `${line ?? `pod-exit-${job.exitCode}`}${detail ? ` · ${detail}` : ''}`, job: job.job };
  }
  const match = /^tsc=(\d+) gate=(\d+)$/.exec(line.slice(expected.length));
  if (!match) return { measured: false, ok: false, rootPlan: null, reason: 'marker-unreadable', job: job.job };
  const planLine = log.split(/\r?\n/).reverse().find((part) => part.startsWith(`${MARKER}_TSC_PLAN `));
  let rootPlan: RootPlanSummary | null = null;
  if (planLine) {
    try {
      const candidate = JSON.parse(planLine.slice(`${MARKER}_TSC_PLAN `.length)) as RootPlanSummary;
      if ((candidate.mode === 'affected' || candidate.mode === 'full') && (candidate.roots === null || Number.isSafeInteger(candidate.roots))
        && typeof candidate.promoted === 'boolean' && (candidate.reason === null || typeof candidate.reason === 'string')) rootPlan = candidate;
    } catch { /* an unreadable plan stays unmeasured */ }
  }
  if (!rootPlan) return { measured: false, ok: false, rootPlan: null, reason: 'root-plan-missing', job: job.job };
  const tscRc = Number(match[1]);
  const gateRc = Number(match[2]);
  return { measured: true, ok: tscRc === 0 && gateRc === 0, rootPlan, tscRc, gateRc, job: job.job };
}
