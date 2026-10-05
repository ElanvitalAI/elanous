// self implement CLI 글루 seam — runDevPipeline 재라우팅(U4b·2026-07-25).
//
// index.ts 의 self implement 액션에서 "테스트 가능한 재라우팅 로직"을 추출한다. 액션은 I/O(parse·console·
// process.exit·--plan 분기·harness-space 진입)만 남기고, 이 seam 이 순수하게: autoReview config 해석 + spec 빌드 +
// runDevPipeline reroute + self 규약 exit-code 를 담당한다(주입 실행 단위테스트 → source-grep Goodhart 회피).
//
// ⚠️ 셋업 substrate(harness-space env·run-identity·log-sink)는 이 seam 이 아니라 액션 최상단에서 진입한다 —
//    --plan 분기(별도 파이프라인 dispatchRunDevHarness)도 그 셋업을 공유해야 하기 때문(무손실). [[standalone-run-context]].
//
// 계약: [[PLAN-unified-selfdev-cli-runDevPipeline-2026-07-25]] §7 U4b · agent-mission mission-cli 대칭.

import { buildSelfImplementDevSpec, executeSelfImplementReroute } from '../self-dev/dev-pipeline.js';
import type { SelfDevJobResult } from '../self-dev/orchestrate.js';
import type { SupervisorJobResult } from '../self-dev/run-supervisor.js';
import type { DevPipelineDeps } from '../self-dev/dev-pipeline.js';
import { parsePositiveInt } from '../self-dev/dev-cli.js';
import type { SelfImplementResult, SelfImplementSeams } from './orchestrator.js';
import type { DocumentReferenceStatus } from './self-implement-runtime.js';
import { resolveObserveOnlyDecision } from './observe-only.js';
import { getUserConfig } from '../user-config.js';
import { resolveAutoReview } from './context-capsule.js';

/** self implement CLI 옵션(commander) — `--no-draft` 는 draft:false 로, `--max-wait` 는 문자열로 도착. */
export interface SelfImplementCliOpts {
  base?: string;
  draft?: boolean;
  openPr?: boolean;
  autoMerge?: boolean;
  mergeByHost?: boolean;
  autoReview?: boolean;
  maxWait?: string;
  enhance?: boolean;
  /** --ground: non-plan goal-loop의 round-0 objective에 codebase grounding을 prepend. */
  ground?: boolean;
  /** Retained only to reject the retired staged-harness entry point explicitly. */
  plan?: boolean;
  /** --observe-only: record the invocation instead of starting a self-build. */
  observeOnly?: boolean;
  /** Natural-language dispatch carries its parent conversation into the self-implement run. */
  parentSessionId?: string;
  /** Natural-language dispatch may preserve a synthesized goal document path. */
  goalFile?: string;
  /** Repository-bounded document references already resolved by the natural-language entry. */
  documentReferences?: readonly DocumentReferenceStatus[];
  /** Marks this invocation as coming from the natural-language dispatch path. */
  naturalLanguageDispatch?: boolean;
  /** Execution ingestion entry supplied by a dispatch adapter; CLI callers retain external-verbatim. */
  entry?: import('../agent-substrate/execution/ingestion-policy.js').IngestionEntry;
  /** HITL PR approval seam injected by the natural-language runtime; never persisted in the plan. */
  approver?: SelfImplementSeams['approvePr'];
  /** Managed-surface pipeline progress sink; absent CLI callers retain stdout fallback. */
  progress?: DevPipelineDeps['progress'];
  /** Caller-allocated run identity. Omitted callers let the harness mint its own. */
  runId?: string;
  /** --child-llm-provider ⊕ --child-llm-model (both or neither). */
  childLlmProvider?: string;
  childLlmModel?: string;
}

export interface SelfImplementCliDeps {
  /** @deprecated compatibility seam; capability defaults are now resolved only by planDevPipeline(). */
  resolveWantAutoReview?: (flag: boolean) => boolean | Promise<boolean>;
  /** reroute 실행(테스트 주입). 기본 executeSelfImplementReroute. */
  executeReroute?: typeof executeSelfImplementReroute;
  /** ⭐ 산출물의 «눈» 심(테스트 주입). 기본은 실제 브라우저 검증(`observeDeliverables`).
   *  ⛔ 심이 «없으면» 이 배선을 시험으로 재현할 수 없고, 그러면 「손으로 돌려 봤다」만 남는다
   *  — 그것은 「그때 됐다」이지 「앞으로도 된다」가 아니다(리뷰 #10556 must-fix). */
  observeDeliverables?: (targets: readonly { taskId: string; target: string }[]) => Promise<{
    readonly deployFindings: ReadonlyMap<string, { target: string; findings?: readonly unknown[] }>;
    readonly unmeasured: readonly unknown[];
  }>;
  /** runDevPipeline 내부 배선 주입(runSelfImplement/seams 등·테스트). */
  pipelineDeps?: DevPipelineDeps;
}

/**
 * ⭐ 런 슈퍼바이저 스위치 — 단일 실행도 「끝까지 돌린다」(2026-08-19 · E2).
 *
 * ⛔ **입구가 아니라 «여기»에 선다.** 대표 2026-08-06: *"능력은 「갈래」가 아니라 「스위치」다"*
 *   ⇒ CLI·NL·데몬이 이 심을 타면 «모두» 같은 능력을 얻는다.
 * ⛔ 기본 off — 안 켜면 동작 무변경이다.
 */
export interface SingleRunSuperviseOptions {
  rounds?: number;
  stallRounds?: number;
  onDecision?: (decision: import('../self-dev/run-supervisor.js').SupervisorDecision) => void;
}

/**
 * ⭐⭐⭐ 단일 실행 결과를 «조각 하나짜리 연합 결과»로 옮긴다 (2026-08-19 · E2).
 *
 * ⛔ **왜 필요한가** — 대표 물음(*"동시에 켜야 하니스 루프가 안 끊기는거죠?"*)에 재보니
 *   ***끊기는 이유가 「프로세스」가 아니라 「층」***이었다:
 *   📏 슈퍼바이저·트리아지가 «연합 층에만» 살고 단일 실행은 그 층을 «안 지난다»(rg 전수 0건).
 *   ⇒ 📌 단일을 ***「조각이 하나인 연합」***으로 보면 같은 판정자가 그대로 본다. 새 로직이 없다.
 *
 * ⛔ taskId 를 runId 로 둔다 — 단일 실행의 «정체»가 그것이고, 원장 조인 키도 그것이다.
 */
type SelfImplementResultWithProposalMetadata = SelfImplementResult
  & Pick<SelfDevJobResult, 'decomposeProposal' | 'goalPlanRevision'>;

export function singleRunAsJobResult(feature: string, r: SelfImplementResultWithProposalMetadata): SupervisorJobResult {
  return {
    taskId: r.runId,
    runId: r.runId,
    feature,
    status: r.ok ? 'done' : 'failed',
    stage: r.stage,
    ...(!r.ok && r.detail ? { error: { message: r.detail } } : {}),
    ...(r.branch ? { branch: r.branch } : {}),
    ...(r.harvestable === true && r.branch ? { harvestable: true } : {}),
    ...(r.worktreePath ? { worktreePath: r.worktreePath } : {}),
    ...(r.prUrl ? { prUrl: r.prUrl } : {}),
    ...(r.merged !== undefined ? { merged: r.merged } : {}),
    ...(r.mergeReason ? { mergeReason: r.mergeReason } : {}),
    ...(r.completionDisposition ? { completionDisposition: r.completionDisposition } : {}),
    ...(r.abandonedClassification?.classification
      ? { failureClassification: r.abandonedClassification.classification } : {}),
    ...(r.decomposeProposal ? { decomposeProposal: r.decomposeProposal } : {}),
    ...(r.goalPlanRevision ? { goalPlanRevision: r.goalPlanRevision } : {}),
    ...(r.salvage !== undefined ? { salvage: r.salvage } : {}),
    ...(r.review?.reviewed !== undefined ? { reviewed: r.review.reviewed } : {}),
    ...(r.review?.failureReason !== undefined ? { reviewReason: r.review.failureReason } : {}),
    // ⭐ 대표 지시(2026-09-08) — 걸음을 슈퍼바이저까지 나른다.
    //   🩸 그 전까지 슈퍼바이저는 「시도의 요약 판정」만 봤고 「어떻게 걸었나」를 «못 봤다».
    //   ⛔ 비어 있으면 «안 싣는다» — 「안 걸었다」와 「관측을 안 붙였다」를 같은 값으로 두지 않는다.
    ...(r.walk && r.walk.length > 0 ? { walk: r.walk } : {}),
  } as SupervisorJobResult;
}

export type SelfImplementCliOutcome =
  | { ok: true; kind: 'self'; result: SelfImplementResult; exitCode: number }
  | { ok: true; kind: 'observed'; source: 'flag' | 'config' | 'default'; exitCode: number }
  | { ok: false; message: string; exitCode: number };

/**
 * self implement 재라우팅 — feature + CLI 옵션을 DevPipelineSpec 으로 무손실 매핑, runDevPipeline 로 자체구현
 * 실행, self 규약 exit-code(실패 stage→1·성공/pr-declined→0)와 함께 outcome 반환. console/process.exit 없음
 * (액션 몫). 예외는 삼켜 ok:false·exit 1(원 액션 catch 동형).
 */
export async function runSelfImplementCliCommand(
  feature: string,
  opts: SelfImplementCliOpts & { supervise?: SingleRunSuperviseOptions },
  deps: SelfImplementCliDeps = {},
): Promise<SelfImplementCliOutcome> {
  try {
    if (opts.plan) {
      return { ok: false, message: '--plan is retired for self implement and is rejected', exitCode: 1 };
    }
    if (opts.mergeByHost === true && (process.env.ELANOUS_SUBSTRATE !== 'pod' || !process.env.ELANOUS_POD_NAME || !process.env.ELANOUS_POD_NAMESPACE)) {
      return { ok: false, message: '--merge-by-host 는 Pod 자식 전용입니다 (호스트 재게이트 인계가 없는 로컬 실행 거부)', exitCode: 1 };
    }
    const observeOnly = resolveObserveOnlyDecision(opts.observeOnly
      ? { ...process.env, ELANOUS_SELF_IMPLEMENT_OBSERVE_ONLY: '1' }
      : process.env);
    if (observeOnly.enabled) {
      const { debug } = await import('../debug/log.js');
      debug.log('self-implement', 'cli.observed', { observeOnly: observeOnly.enabled, observeOnlySource: observeOnly.source });
      return { ok: true, kind: 'observed', source: observeOnly.source, exitCode: 0 };
    }
    const draft = opts.draft !== false; // --no-draft → false·기본 draft
    // A human flag wins. Otherwise preserve the production config decision as config
    // provenance; tests may override only this reader seam. With neither decision,
    // omission reaches the shared launch resolver unchanged.
    const configuredAutoReview = opts.autoReview === undefined && !opts.naturalLanguageDispatch
      ? deps.resolveWantAutoReview
        ? await deps.resolveWantAutoReview(false)
        : resolveAutoReview(getUserConfig().autoReview?.mode ?? 'opt-in', false)
      : undefined;
    const childProvider = opts.childLlmProvider?.trim();
    const childModel = opts.childLlmModel?.trim();
    if (!childProvider !== !childModel) throw new Error('--child-llm-provider and --child-llm-model go together');
    const childLlm = childProvider && childModel ? { provider: childProvider, model: childModel, source: 'flag' as const } : undefined;
    const spec = buildSelfImplementDevSpec({
      feature,
      ...(opts.base ? { base: opts.base } : {}),
      ...(opts.enhance ? { enhance: true } : {}),
      ...(opts.ground ? { ground: true } : {}),
      draft,
      ...(opts.autoMerge !== undefined ? { autoMerge: opts.autoMerge } : {}),
      ...(opts.mergeByHost === true ? { mergeByHost: true, autoMerge: true } : {}),
      ...(opts.openPr !== undefined ? { openPr: opts.openPr } : {}),
      ...(opts.autoReview !== undefined
        ? { autoReview: opts.autoReview, autoReviewSource: 'request' as const }
        : configuredAutoReview !== undefined
          ? { autoReview: configuredAutoReview, autoReviewSource: 'config' as const }
          : {}),
      ...(opts.maxWait !== undefined ? { maxWaitSec: parsePositiveInt(opts.maxWait, '--max-wait') } : {}),
      ...(opts.parentSessionId ? { parentSessionId: opts.parentSessionId } : {}),
      ...(opts.goalFile ? { goalFile: opts.goalFile } : {}),
      ...(opts.documentReferences ? { documentReferences: opts.documentReferences } : {}),
      ...(opts.naturalLanguageDispatch ? { naturalLanguageDispatch: true } : {}),
      ...(opts.runId ? { runId: opts.runId } : {}),
      ...(childLlm ? { childLlm } : {}),
      entry: opts.entry ?? 'external-verbatim', // CLI = 외부 창구(외부가 프롬프트 엔지니어 → verbatim 존중)
    });
    spec.entrance = opts.naturalLanguageDispatch ? 'nl-self-implement' : 'cli-self-implement';
    const pipelineDeps = opts.approver || opts.progress
      ? { ...deps.pipelineDeps, ...(opts.approver ? { approver: opts.approver } : {}), ...(opts.progress ? { progress: opts.progress } : {}) }
      : deps.pipelineDeps;
    const exec = deps.executeReroute ?? executeSelfImplementReroute;
    let { result, exitCode } = await exec(spec, pipelineDeps ? { pipelineDeps } : undefined);

    // ⭐⭐⭐ 단일 실행도 «루프»를 지난다 (E2) — 판정자는 연합과 «같은 자»다.
    //   ⛔ 종전엔 단일이 실패하면 그냥 끝났다. 아무도 「다시 걸까」를 묻지 않았다.
    //     📏 그리고 사람이 가장 많이 쓰는 길이 그 길이다(30일 SelfImplement 17 · SelfOrchestrate 0).
    //   ⛔ 기본 off — 안 켜면 위 한 줄로 끝난다(동작 무변경).
    if (opts.supervise) {
      const { superviseRun } = await import('../self-dev/run-supervisor.js');
      const { debug } = await import('../debug/log.js');
      const limits = {
        ...(opts.supervise.rounds === undefined ? {} : { maxRounds: opts.supervise.rounds }),
        ...(opts.supervise.stallRounds === undefined ? {} : { stallRounds: opts.supervise.stallRounds }),
      };
      // ⭐⭐⭐ 산출물의 «눈» — 단일 경로가 이제 자기 골의 「켜기 선언」을 읽고 그 앱을 «본다».
      //
      //   🔑 왜 여기서 되나: `dev --file <골>` 은 골 문서 «전문»을 feature 로 싣는다
      //     (dev-pipeline.ts `feature: text`). ⇒ 조각이 자기 문서를 모르는 연합과 달리
      //     단일 경로는 ***이미 문서를 손에 들고 있다.***
      //   ⛔ 선언이 없으면 눈을 «안 단다» — 빈 관측을 만들어 「결함 0」으로 읽히게 하지 않는다.
      const { buildDeliverableTargets } = await import('../self-dev/deliverable-target-wiring.js');
      const wiring = buildDeliverableTargets(feature, ['single'], 'all', '127.0.0.1');
      if (!wiring.wired) {
        try { debug.log('self-dev.supervisor', 'deliverable-eye.skipped', { reason: wiring.reason, surface: 'single' }); }
        catch { /* fail-open */ }
      }
      const deliverableEye = wiring.wired
        ? async () => {
            if (deps.observeDeliverables !== undefined) return deps.observeDeliverables(wiring.targets);
            const { observeDeliverables } = await import('../harness/deliverable-observation.js');
            return observeDeliverables(wiring.targets);
          }
        : undefined;

      await superviseRun({
        initial: [singleRunAsJobResult(feature, result)],
        limits,
        ...(deliverableEye ? { observeDeliverables: deliverableEye } : {}),
        ...(opts.supervise.onDecision ? { onDecision: opts.supervise.onDecision } : {}),
        observe: (event, data) => {
          try { debug.log('self-dev.supervisor', event, { ...data, surface: 'single' }); } catch { /* fail-open */ }
        },
        // ⛔ 단일의 「다시 걸기」는 «같은 골을 다시»다 — 연합의 resumeFrom 과 다르다.
        //   ⇒ 그래서 판정은 «같고» 집행만 여기서 안다(superviseRun 은 그것을 모른다).
        rerun: async () => {
          const next = await exec(spec, pipelineDeps ? { pipelineDeps } : undefined);
          result = next.result;
          exitCode = next.exitCode;
          return [singleRunAsJobResult(feature, next.result)];
        },
      });
    }

    return { ok: true, kind: 'self', result, exitCode };
  } catch (e) {
    return { ok: false, message: String((e as { message?: string })?.message ?? e), exitCode: 1 };
  }
}
