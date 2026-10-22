import { buildHarnessRunDevSpec, runDevPipeline, type DevHarnessDispatchArgs, type DevPipelineDeps } from './dev-pipeline.js';
import type { SurfaceUxSource } from '../agent/surface-ux/build.js';
import { debug } from '../debug/log.js';
import { CLI_HARNESS_RUN_ENTRANCE, retiredEntranceNotice } from './entrance-registry.js';
import { HARNESS_RUN_REPLACEMENT } from './cli-help-text.js';
export { HARNESS_RUN_REPLACEMENT, HARNESS_RUN_DEPRECATION_HELP } from './cli-help-text.js';

/** `elanous logs --category`로 레거시 입구의 제거 안전시점을 조회하는 브레드크럼. */
export const HARNESS_RUN_DEPRECATION_LOG_CATEGORY = 'harness-cli.deprecated';
/** 실행 «중»에 사람에게 내는 한 줄. ⛔ `--help` 용은 아래 HARNESS_RUN_DEPRECATION_HELP 다 —
 *  그쪽은 레지스트리가 은퇴 표시와 «갈 곳»을 이미 붙이므로 여기서 그것을 되풀이하지 않는다. */
export const HARNESS_RUN_DEPRECATION_NOTICE = `ℹ️  \`elanous harness run\`은 deprecated 입구입니다 — \`${HARNESS_RUN_REPLACEMENT}\`로 이행하세요.`;

/** ⭐ 진행 릴레이를 «단 곳» — 하니스 시퀀서가 스테이지마다 내는 progress 를 CLI 부모 stdout 까지 잇는다.
 *
 *  ⛔ **왜 `ctx` 가 아니라 `deps.uxSource` 인가**: `dispatchRunDevHarness` 의 detached 가드가
 *  `if (ctx && !deps && …)` 다. ctx 를 주는 순간 subprocess 위임으로 «갈린다» — CLI 는 인프로세스여야 하므로
 *  진행 sink 를 3번째 인자(`deps`)로 넣는다. 그러면 그 함수가 `deps.uxSource ?? ctx ?? {}` 로 ux 를 만든다.
 *
 *  ⛔ 재발명 0 — `SurfaceUx.progress` ← `emitFeedback`(`tool.progress` 엔벨로프) 계약을 그대로 쓴다.
 *  막(`membraneProgress`)이 `seams.onProgress` 로 이미 그 길에 걸려 있다. */
export function harnessProgressUxSource(onProgress: (line: string) => void): SurfaceUxSource {
  return {
    emitFeedback: (env) => {
      // ⛔ 진행 이외의 엔벨로프는 흘리지 않는다 — 부모 stdout 은 「스테이지 진행」만 받는다.
      if (env.kind !== 'tool.progress') return;
      // ⛔⭐ `phase:'end'` 는 «거른다» — 그것은 종결 «요약»이고 `result.detail` 전문을 싣는다.
      //   CLI 는 그 직후 `outcome.output` 을 스스로 찍으므로 그대로 두면 ***같은 블록이 두 번*** 나온다
      //   (2026-08-11 라이브 실측). ⛔ 문면을 «자르지» 않는다 — 중복인 쪽을 «안 받는다».
      //   ⚠️ 다른 서피스(telegram·detached)에서는 그 end 카드가 «유일한 배달»이라 거기선 그대로 간다 —
      //     이 필터는 CLI 어댑터 «안»에만 있다.
      if (env.phase === 'end') return;
      for (const line of env.payload.lines) onProgress(line);
    },
  };
}

function progressRelayingDispatch(
  onProgress: (line: string) => void,
  pipelineDeps: DevPipelineDeps | undefined,
): (args: DevHarnessDispatchArgs) => Promise<{ output: string }> {
  // 주입된 dispatch 가 있으면 그것이 이긴다 — 기존 시험의 무실행 주입 계약을 깨지 않는다.
  if (pipelineDeps?.dispatchRunDevHarness) return pipelineDeps.dispatchRunDevHarness;
  return async (args) => {
    const { dispatchRunDevHarness } = await import('../skills/tools/dev-harness.js');
    return dispatchRunDevHarness(args, undefined, { uxSource: harnessProgressUxSource(onProgress) });
  };
}

export interface HarnessRunCliOpts {
  target?: string;
  autoDrive?: 'off' | 'safe' | 'on';
  autoReview?: boolean;
  base?: string;
  redTeam?: boolean;
  multiAngle?: boolean;
  domain?: string;
  carryCapsule?: boolean;
  sizingMode?: 'off' | 'observe';
  ledgerMode?: 'off' | 'observe';
}

export interface HarnessRunCliDeps {
  runDevPipeline?: typeof runDevPipeline;
  pipelineDeps?: DevPipelineDeps;
  /** 실제 retired 입구 선언을 보존한 발사 관측 seam. */
  logLaunchEntrance?: (data: { entrance: string; entranceStatus: string }) => void;
  /** Deprecated invocation 관측과 안내는 fail-open — 안내 실패가 거부를 삼키지 않는다. */
  onDeprecatedInvocation?: () => void;
  onDeprecationNotice?: (notice: string) => void;
  /** ⭐ 스테이지 진행 한 줄씩 — 주면 `[harness:<stage>] <message>` 가 여기로 온다. 안 주면 종전과 «글자 그대로» 같다.
   *  📏 왜 생겼나(2026-08-11 실측): `harness run` 이 plan→execute→review→deploy 를 8분 3초에 완주하는 동안
   *    부모 stdout 이 «0줄»이었고 끝나서야 결과 3줄이 나왔다. 같은 시각 `dev --ask`(self implement 갈래)는
   *    `[self-implement:<stage>]` 를 계속 흘렸다. 시퀀서·막·릴레이는 «이미» 있었고 CLI 경로만 안 이어져 있었다. */
  onProgress?: (line: string) => void;
}

export type HarnessRunCliOutcome =
  | { ok: true; output: string; exitCode: number }
  | { ok: false; message: string; exitCode: number };

function observeDeprecatedHarnessRunInvocation(deps: HarnessRunCliDeps): void {
  const entrance = CLI_HARNESS_RUN_ENTRANCE;
  try {
    (deps.onDeprecatedInvocation ?? (() => {
      debug.log(HARNESS_RUN_DEPRECATION_LOG_CATEGORY, 'harness-run-invoked', {
        replacement: HARNESS_RUN_REPLACEMENT, entrance: entrance.id, entranceStatus: entrance.status,
      });
    }))();
  } catch { /* fail-open — counting must not swallow the closed entrance */ }
  try {
    deps.logLaunchEntrance?.({ entrance: entrance.id, entranceStatus: entrance.status });
  } catch { /* fail-open — observation must not swallow the closed entrance */ }
  try {
    const printNotice = deps.onDeprecationNotice ?? ((line: string) => process.stderr.write(`${line}\n`));
    const retirementNotice = retiredEntranceNotice(entrance);
    if (retirementNotice) printNotice(retirementNotice);
    printNotice(HARNESS_RUN_DEPRECATION_NOTICE);
  } catch { /* fail-open — guidance print must not swallow the closed entrance */ }
}

/** 옛 파이프라인 본문 — CLI 입구(`runHarnessRunCliCommand`)는 더 이상 이것을 부르지 않는다. */
export async function runHarnessRunPipeline(
  objectiveParts: string[],
  opts: HarnessRunCliOpts,
  deps: HarnessRunCliDeps = {},
): Promise<HarnessRunCliOutcome> {
  const objective = objectiveParts.join(' ').trim();
  if (!objective) return { ok: false, message: 'objective 필요', exitCode: 1 };
  try {
    const spec = buildHarnessRunDevSpec({ objective, ...opts });
    const run = deps.runDevPipeline ?? runDevPipeline;
    const pipelineDeps = deps.onProgress
      ? { ...(deps.pipelineDeps ?? {}), dispatchRunDevHarness: progressRelayingDispatch(deps.onProgress, deps.pipelineDeps) }
      : deps.pipelineDeps ?? {};
    const result = await run(spec, pipelineDeps);
    if (result.kind !== 'plan-staged') {
      throw new Error(`runHarnessRunCliCommand: 예상 밖 dispatch(kind=${result.kind}) — plan-staged spec 이어야`);
    }
    return { ok: true, output: result.result.output, exitCode: 0 };
  } catch (error) {
    return { ok: false, message: String((error as { message?: string })?.message ?? error), exitCode: 1 };
  }
}

export async function runHarnessRunCliCommand(
  objectiveParts: string[],
  _opts: HarnessRunCliOpts,
  deps: HarnessRunCliDeps = {},
): Promise<HarnessRunCliOutcome> {
  const objective = objectiveParts.join(' ').trim();
  if (!objective) return { ok: false, message: 'objective 필요', exitCode: 1 };
  observeDeprecatedHarnessRunInvocation(deps);
  return { ok: false, message: HARNESS_RUN_DEPRECATION_NOTICE, exitCode: 1 };
}

/** outcome → process.exitCode 적용(원 액션의 exit-code 규약 보존). 성공(ok)이면 process.exitCode 를 건드리지
 *  않는다 — 원 `harness run` 액션은 성공 시 exitCode 를 미설정으로 남겼다(console.log 만). 실패면만 exitCode(=1)
 *  를 설정한다(원 catch 동형). orchestrate/mission 재라우팅의 `if (exitCode !== 0)` 가드와 대칭. process 처럼
 *  { exitCode?: number } 핸들을 받아 순수 테스트 가능. */
/** process 처럼 exitCode 를 담는 최소 핸들(순수 테스트용) — process.exitCode 는 number|string|undefined. */
export type ExitCodeHolder = { exitCode?: number | string | undefined };

export function applyHarnessRunOutcomeExit(
  outcome: HarnessRunCliOutcome,
  proc: ExitCodeHolder = process as ExitCodeHolder,
): void {
  if (outcome.ok) return;
  proc.exitCode = outcome.exitCode;
}
