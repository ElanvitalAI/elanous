// self orchestrate CLI 글루 seam — runDevPipeline parallel dispatch 재라우팅(U4b·2026-07-25).
//
// index.ts 의 self orchestrate 액션에서 "재라우팅 실행"만 추출한다. 액션은 여전히 coordinator 해석
// (goal 분리·--decompose·run-identity·checkpoint·--board·promoteDefaults)을 담당하고, 이 seam 은 그 결과
// (goals + concurrency + 감독/영속 콜백)를 받아 runDevPipeline 로 실행하고 orchestrate 규약 exit-code 를 매핑한다.
// orchestrateSelfDev 는 리치한 TOX coordinator 라 전량 재호스팅 대신 호출부만 통일(재발명 0·저위험 touch).
//
// 계약: [[PLAN-unified-selfdev-cli-runDevPipeline-2026-07-25]] §7 U4b · self-implement-cli 대칭.

import { buildDeliverableTargets, type DeliverableAttribution } from './deliverable-target-wiring.js';
import { launchAndVerifyGoalDeliverable } from '../harness/deliverable-verify-cli.js';
import type { DeployVerifyResult } from '../harness/browser-verify.js';
import { buildSelfOrchestrateDevSpec, executeOrchestrateReroute } from './dev-pipeline.js';
import type { DevPipelineDeps, OrchestrateRuntime } from './dev-pipeline.js';
import { resolveOrchestrateConcurrency, resumeKey } from './orchestrate.js';
import type { FailureClassification, SelfDevGoal, SelfDevJobResult } from './orchestrate.js';
import { superviseRun, type SupervisorDecision } from './run-supervisor.js';
import { readDecomposeProposals, applyDecomposeProposals } from './decompose-proposal.js';
import { createRoundPrTracker, defaultRoundPrAdapters, type RoundPrAdapters } from './round-pr-supersede.js';
import { createHash } from 'node:crypto';
import { debug } from '../debug/log.js';

export interface OrchestrateCliInput {
  /** 이미 해석된 goals(분리+decompose+promoteDefaults 적용·per-goal 데이터). */
  goals: SelfDevGoal[];
  /** ⭐ 산출물 관측 배선. 주면 골 문서의 「켜기 선언」에서 타깃을 만들어 런타임에 싣는다.
   *  ⛔⭐ **문서와 귀속을 «한 칸»으로 묶는다** — 따로 두고 귀속에 기본값을 주면
   *  「어느 조각에 귀속하는지 모르는 호출자」가 «모든 조각에 귀속했다»는 사실을 만든다(리뷰 #10550).
   *  ⇒ 묶으면 그 상태가 «타입에서» 불가능해진다. 배선을 원하면 귀속을 «고르라».
   *  ⛔ 조각은 «자기 문서»를 갖지 않는다 — N조각이 «한» 문서에서 파생되므로 여기서 «한 번» 읽고
   *  결과를 인자로 내린다(실행 맥락 계약과 같은 형태). 생략하면 종전과 «바이트 동일»하게 흐른다. */
  deliverable?: { readonly document: string; readonly attribution: DeliverableAttribution; readonly goalPath?: string };
  /** CLI 지정 시만(미지정 → undefined → orchestrate surface cap 2). */
  concurrency?: number;
  /** --decompose 가 보존한 정규화 원문. 비분해 호출에서는 키 자체를 생략한다. */
  parentRequest?: string;
  /** 감독/영속 콜백(teardown·resumeFrom·onSnapshot·checkpoint·onEvent 등). */
  runtime: OrchestrateRuntime;
  /**
   * ⭐⭐⭐ 런 슈퍼바이저 — 「끝까지 돌린다」 스위치 (2026-08-19).
   *
   * ⛔ **이 축이 «여기» 있는 것이 핵심이다.** 초판은 이것을 `index.ts`(CLI 액션)에 두었고,
   *   그러면 CLI «한 입구»만 능력을 갖는다. 대표 2026-08-06 이 이미 그 형태를 금했다 —
   *   ***"능력은 「갈래」가 아니라 「스위치」다 · 슈퍼바이저가 그 스위치를 «소유»한다"***
   *   (`RFC-run-supervisor-single-control-point` §2b⑷ · §2c⑵).
   * ⇒ 📌 입구(CLI·NL·슬래시·데몬)는 이 값을 «말하기»만 하고, 판정과 루프는 이 심이 한다.
   */
  supervise?: {
    /** 재개 라운드 상한(첫 런은 라운드 0). 기본 3. */
    rounds?: number;
    /** 진전 없이 견디는 라운드 수. 기본 2. */
    stallRounds?: number;
    /** 라운드마다 판정을 사람에게 보이고 싶은 입구가 쓴다(중앙은 console 을 쓰지 않는다). */
    onDecision?: (decision: SupervisorDecision) => void;
  };
}

/** Maximum repair fragments appended over one supervised CLI run. */
/**
 * 병렬 실행 시작 안내 한 줄. ⛔ 동시성을 «추측하지 않는다».
 *
 * 🔑 종전 문면은 `동시 ${concurrency ?? 2}` 였다 — 명시값이 없으면 «2» 를 찍었는데,
 *   엔진이 실제로 쓰는 값은 `resolveOrchestrateConcurrency()` 가 런타임 병렬도로 해석한 것이라
 *   ***사람이 본 수와 기계가 쓴 수가 달랐다***. 해석에 실패했으면 그 사실을 «이름으로» 말한다.
 * ⚠️ 나머지 텔레메트리(goal 수·promote 모드·teardown·runId·resume)는 «그대로» 보존한다 —
 *   장시간 실행에서 그 줄이 유일한 시작 관측이다.
 */
export function formatOrchestrateStartAnnouncement(input: {
  goalCount: number;
  /** 이미 해석된 동시성. `undefined` 는 「모른다」이며 임의의 기본값으로 바꾸지 않는다. */
  concurrency: number | undefined;
  promoteMode: string;
  teardown?: boolean;
  runId: string;
  resume?: { skipped: number; rerun: number };
}): string {
  const concurrency = input.concurrency === undefined ? '알 수 없음' : String(input.concurrency);
  const resume = input.resume ? ` (resume·${input.resume.skipped} 스킵 · ${input.resume.rerun} 재실행)` : '';
  return `[self-dev] ${input.goalCount} goal 병렬 실행 (동시 ${concurrency})${input.promoteMode}${input.teardown ? ' · teardown' : ''} · run ${input.runId}${resume}`;
}

export interface OrchestrateStartResolution {
  /** 실행부에 넘길 값. `undefined` 는 「모른다」이며 안내 문면도 같은 사실을 말한다. */
  readonly concurrency: number | undefined;
  /** 사람에게 찍을 시작 안내 한 줄. 위 `concurrency` 와 «같은 값»에서 나온다. */
  readonly announcement: string;
}

/**
 * 시작 «해석»과 «안내»를 한 번에 낸다 — ⛔ 둘이 갈리지 못하게 «구조로» 묶는다.
 *
 * 🔑 종전엔 안내가 `concurrency ?? 2` 로 «따로» 추측했고 실행부는 다른 값을 썼다.
 *   그 어긋남을 소스 검사로 막으면 「다른 자리에 같은 문자열」로 통과한다(리뷰 지적 2026-08-21).
 *   ⇒ 📌 ***한 함수가 둘을 «같은 값»에서 내면 어긋남이 원리상 불가능하다.***
 * ⚠️ 해석은 «한 번»만 일어난다 — 이 함수가 seam 을 정확히 한 번 부른다.
 */
export function resolveOrchestrateStart(input: {
  explicit: number | undefined;
  goalCount: number;
  promoteMode: string;
  teardown?: boolean;
  runId: string;
  resume?: { skipped: number; rerun: number };
  /** 해석 seam — 생략하면 실제 해석기를 쓴다. 시험이 「몇 번 불렸나」를 여기서 센다. */
  resolveConcurrency?: (explicit: number | undefined) => number | undefined;
}): OrchestrateStartResolution {
  const concurrency = (input.resolveConcurrency ?? resolveOrchestrateConcurrency)(input.explicit);
  return {
    concurrency,
    announcement: formatOrchestrateStartAnnouncement({
      goalCount: input.goalCount,
      concurrency,
      promoteMode: input.promoteMode,
      ...(input.teardown ? { teardown: true } : {}),
      runId: input.runId,
      ...(input.resume ? { resume: input.resume } : {}),
    }),
  };
}

export const MAX_REPAIR_FRAGMENTS_TOTAL = 8;
/** A normalized error-code fingerprint is repaired at most once per supervised CLI run. */
export const MAX_REPAIR_FRAGMENTS_PER_FINGERPRINT = 1;

export type RepairFragmentSkipReason = 'duplicate' | 'invalid' | 'per-fingerprint-limit' | 'total-limit';

export interface RepairFragmentOutcome {
  fingerprint: string;
  status: 'added' | 'skipped';
  reason?: RepairFragmentSkipReason;
}

export interface RepairFragmentAppendResult {
  goals: SelfDevGoal[];
  added: RepairFragmentOutcome[];
  skipped: RepairFragmentOutcome[];
}

export interface RepairAppendObservation {
  added: RepairFragmentOutcome[];
  skipped: RepairFragmentOutcome[];
}

function repairFingerprint(classification: Pick<FailureClassification, 'errorCode' | 'errorMessage' | 'taskId'>): string {
  const errorCode = classification.errorCode.trim();
  if (errorCode !== 'UNKNOWN') return errorCode;
  const detail = [
    `task:${classification.taskId.trim() || '(unknown-task)'}`,
    `message:${classification.errorMessage?.trim() || '(unknown-message)'}`,
  ].join('\u0000');
  return `UNKNOWN:${createHash('sha256').update(detail).digest('hex').slice(0, 16)}`;
}

/** Adds deterministic repair goals without replacing the completed/original goal fragments. */
export function appendRepairFragments(
  goals: readonly SelfDevGoal[],
  classifications: readonly Pick<FailureClassification, 'action' | 'errorCode' | 'errorMessage' | 'taskId'>[],
  options: { readonly seenFingerprints?: ReadonlyMap<string, number>; readonly addedCount?: number } = {},
): RepairFragmentAppendResult {
  const seen = new Map(options.seenFingerprints);
  const existingFingerprints = new Set(goals.flatMap((goal) => goal.id?.startsWith('repair:') ? [goal.id.slice('repair:'.length)] : []));
  const addedCount = options.addedCount ?? 0;
  const added: RepairFragmentOutcome[] = [];
  const skipped: RepairFragmentOutcome[] = [];
  const next = [...goals];

  for (const classification of classifications) {
    if (classification.action !== 'add-repair-task') continue;
    const fingerprint = repairFingerprint(classification);
    if (!fingerprint) {
      skipped.push({ fingerprint: classification.errorCode, status: 'skipped', reason: 'invalid' });
      continue;
    }
    const existing = seen.get(fingerprint) ?? 0;
    if (existingFingerprints.has(fingerprint)) {
      skipped.push({ fingerprint, status: 'skipped', reason: 'duplicate' });
      continue;
    }
    if (existing >= MAX_REPAIR_FRAGMENTS_PER_FINGERPRINT) {
      skipped.push({ fingerprint, status: 'skipped', reason: 'per-fingerprint-limit' });
      continue;
    }
    if (addedCount + added.length >= MAX_REPAIR_FRAGMENTS_TOTAL) {
      skipped.push({ fingerprint, status: 'skipped', reason: 'total-limit' });
      continue;
    }
    seen.set(fingerprint, existing + 1);
    existingFingerprints.add(fingerprint);
    const repair: SelfDevGoal = {
      id: `repair:${fingerprint}`,
      feature: `Repair deliverable failure: ${fingerprint}`,
      goalType: 'implement',
    };
    next.push(repair);
    added.push({ fingerprint, status: 'added' });
  }
  return { goals: next, added, skipped };
}

/** ⛔ 산출물은 «이 기계의 루프백»에 뜬다(artifact-launcher 가 그렇게 띄운다).
 *  그 사실을 «아는 층»이 여기라서 여기서 준다 — 모르는 층의 기본값이 되면 「그럴듯한 값」이다. */
const DELIVERABLE_OBSERVATION_HOST = '127.0.0.1';

export interface OrchestrateCliDeps {
  /** reroute 실행(테스트 주입). 기본 executeOrchestrateReroute. */
  executeReroute?: typeof executeOrchestrateReroute;
  /** launch-declared deliverable lifecycle verifier seam (tests). */
  launchAndVerifyGoalDeliverable?: typeof launchAndVerifyGoalDeliverable;
  /** repository root passed to the artifact launcher. */
  repositoryRoot?: string;
  /** runDevPipeline 내부 배선 주입(orchestrateSelfDev 엔진 등·테스트). */
  pipelineDeps?: DevPipelineDeps;
  /** 분해 제안과 골 개정 시도 되채움 조회(테스트 주입). 기본 readDecomposeProposals(원장). */
  readProposals?: typeof readDecomposeProposals;
  /** DRAFT-TRIAGE — gh seams for superseding the previous supervisor round's draft PR (tests). */
  roundPrAdapters?: RoundPrAdapters;
}

/**
 * Produces the launch lifecycle verifier only for a target built from a launch
 * declaration.  Undefined intentionally preserves orchestrate.ts's normal
 * observation verifier for undeclared documents.
 */
export function createLaunchDeclaredDeliverableVerifier(
  deliverableWiring: ReturnType<typeof buildDeliverableTargets> | undefined,
  goalPath: string | undefined,
  deps: Pick<OrchestrateCliDeps, 'launchAndVerifyGoalDeliverable' | 'repositoryRoot'> = {},
): OrchestrateRuntime['verifyDeliverable'] | undefined {
  if (deliverableWiring?.wired !== true) return undefined;
  if (!goalPath) throw new Error('Launch-declared deliverable requires a canonical goal path');

  const repositoryRoot = deps.repositoryRoot ?? process.cwd();
  const launch = deps.launchAndVerifyGoalDeliverable ?? launchAndVerifyGoalDeliverable;
  let reportPromise: ReturnType<typeof launchAndVerifyGoalDeliverable> | undefined;
  return async (target: string): Promise<DeployVerifyResult> => {
    reportPromise ??= launch(goalPath, repositoryRoot);
    const report = await reportPromise;
    if (report.status !== 'observed' || !report.observation) {
      throw new Error(`Launch-declared deliverable verification failed: ${report.status}`);
    }
    const verified = report.observation.deployFindings.get(goalPath);
    if (!verified) {
      throw new Error(`Launch-declared deliverable verification is unmeasured: no finding for ${goalPath}`);
    }
    if (verified.target !== target) {
      throw new Error(`Launch-declared deliverable verification target mismatch: expected ${target}, got ${verified.target}`);
    }
    const structuredFindings = [...(verified.findings ?? [])];
    return {
      ok: structuredFindings.length === 0,
      url: target,
      findings: structuredFindings.map(({ message }) => message),
      ...(structuredFindings.length ? { structuredFindings } : {}),
    };
  };
}

export type OrchestrateCliOutcome =
  | { ok: true; results: SelfDevJobResult[]; exitCode: number; repairAppend?: RepairAppendObservation[] }
  | { ok: false; message: string; exitCode: number };

/**
 * self orchestrate 재라우팅 — 해석된 goals/concurrency/runtime 을 parallel DevPipelineSpec 으로 매핑, runDevPipeline
 * 로 orchestrateSelfDev 를 실행, orchestrate 규약 exit-code(done<total→1)와 함께 outcome 반환. console/process.exit
 * 없음(액션 몫). 예외는 삼켜 ok:false·exit 1(원 액션 catch 동형).
 */
/**
 * ⭐⭐⭐ 중앙이 결과를 «완성»해서 출구 모듈(트리아지·슈퍼바이저)에 준다 (2026-08-19).
 *
 * ⛔ **왜 중앙인가** — 출구 모듈은 ***「이 값이 어디서 왔는지 몰라야」*** 한다.
 *   트리아지가 「원장을 볼지 결과를 볼지」를 알면 실행 방식이 바뀔 때마다 그 안에 else if 가 늘고,
 *   그것이 대표 2026-08-06 이 금한 「능력이 갈래를 만든다」다.
 *
 * ⛔ **왜 원장인가** — 분해 제안(«pieces»)은 자식 결과로 «안 온다».
 *   전선 타입(SelfImplementDisposition)에 칸이 없고, 값은 원장에만 구조화되어 남는다.
 *   🅣 의 정정된 권고(2026-08-19): *"손에 없으면 원장이 «유일한» 손이다."*
 *
 * ⭐ **되채움이 「일어났다」를 관측에 남긴다**(🅣 A3) — 그 수가 무엇을 뜻하는지가 값이 된다:
 *   요청 대비 채워진 수가 «안 오르면» 자식 쪽 산출이나 shardId 배선에 구멍이 있다는 신호다.
 *   ⛔ 그리고 「0건」을 읽기 «전»에 볼 것을 같이 남긴다 — 디렉토리 부재 · 못 읽은 파일.
 */
function backfillDecomposeProposals(
  results: SelfDevJobResult[],
  deps: OrchestrateCliDeps,
): SelfDevJobResult[] {
  // 착지한 조각은 물을 이유가 없다. 「다시 걸 후보」만 묻는다.
  const candidates = results.filter((r) => !(r.stage === 'merged' && r.merged === true) && (!r.decomposeProposal || !r.goalPlanRevision));
  if (candidates.length === 0) return results;
  const shardIds = candidates.map((r) => r.taskId);
  const runIds = [...new Set(candidates.flatMap((r) => r.runId?.trim() ? [r.runId] : []))];
  let scan;
  try {
    scan = (deps.readProposals ?? readDecomposeProposals)({ shardIds, runIds });
  } catch (e) {
    // ⛔ 되채움 실패가 런을 죽이지 않는다 — 다만 «조용히» 넘어가지도 않는다.
    try {
      debug.log('self-dev.supervisor', 'decompose-proposal.backfill-failed',
        { requested: shardIds.length, runIds: runIds.length, error: String((e as { message?: string })?.message ?? e).slice(0, 200) }, { level: 'warn' });
    } catch { /* fail-open */ }
    return results;
  }
  try {
    debug.log('self-dev.supervisor', 'decompose-proposal.backfill', {
      requested: shardIds.length,
      runIds: runIds.length,
      filled: scan.proposals.size,
      goalPlanRevisions: scan.goalPlanRevisions.size,
      readFailure: scan.readFailure?.reason,
      scannedFiles: scan.scannedFiles,
      unreadableFiles: scan.unreadableFiles,
      directoryMissing: scan.directoryMissing,
    }, scan.unreadableFiles > 0 || scan.directoryMissing ? { level: 'warn' } : undefined);
  } catch { /* fail-open */ }
  // ⛔ 「아무것도 못 찾았으니 그냥 돌려준다」로 «조기 반환하지 않는다» — 성공한 스캔에서
  //   그 런의 항목이 없다는 것은 «답»이고(시도 0), 안 실으면 undefined 가 되어
  //   「아직 안 읽음」과 다시 같아진다(리뷰 must-fix 2026-08-21 · 판정 신호 ②).
  // ⭐ 다만 «조회한 후보»에만 쓴다 — 물어보지 않은 결과(이미 착지한 조각 등)에
  //   관측을 새로 쓰면 「안 물어본 것」에 답이 생긴다.
  const queried = new Set(candidates.map((c) => c.taskId));
  return results.map((r) => {
    if (!queried.has(r.taskId)) return r;
    const runId = r.runId?.trim();
    const proposal = scan!.proposals.get(r.taskId)
      ?? (runId ? scan!.proposals.get(runId) : undefined);
    // 항목별 원장 관측이 부분 스캔의 전역 실패보다 우선한다. 어떤 metadata도 없으면
    // unknown을 보존해 「이 런에 revision이 없었다」를 읽은 사실로 합성하지 않는다.
    const revision = scan!.goalPlanRevisions.get(r.taskId)
      ?? (runId ? scan!.goalPlanRevisions.get(runId) : undefined)
      ?? scan!.readFailure;
    return {
      ...r,
      ...(proposal ? { decomposeProposal: { pieces: proposal.pieces } } : {}),
      ...(revision ? { goalPlanRevision: revision } : {}),
    };
  });
}

export async function runSelfOrchestrateCliCommand(
  input: OrchestrateCliInput,
  deps: OrchestrateCliDeps = {},
): Promise<OrchestrateCliOutcome> {
  try {
    // ⭐ goals·spec 이 «라운드마다 바뀔 수 있다» — 분해 제안이 조각을 쪼개면 연합으로 승격된다.
    let currentGoals = input.goals;
    let spec = buildSelfOrchestrateDevSpec(currentGoals, input.concurrency);
    /** 이미 쪼갠 goal — ⛔ 같은 것을 두 번 쪼개면 조각이 무한히 불어난다. */
    const decomposedFeatures = new Set<string>();
    const repairFingerprints = new Map<string, number>();
    const repairAppend: RepairAppendObservation[] = [];
    let repairFragmentsAdded = 0;
    let currentDecision: SupervisorDecision | undefined;
    // ⭐⭐ 산출물 관측 타깃 — 골 문서의 «켜기 선언»을 «한 번» 읽어 런타임에 싣는다.
    //   ⛔⭐ **재계산하지 않는다 — 이것은 «결정»이다**(리뷰 #10550 should-fix):
    //     슈퍼바이저가 수리 조각을 더하거나 분해가 currentGoals 를 갈아도 타깃은 «최초 goals» 기준이다.
    //     이유 — 산출물은 「이 연합이 «무엇을 냈나»」에 대한 관측이지 조각마다의 관측이 아니다.
    //     같은 앱을 여는 URL 을 조각 수만큼 늘리면 «같은 화면을 N번» 열고 결함도 N번 센다.
    //     ⇒ 조각별 관측이 필요하다는 근거가 나오면 그때 연다. 지금 열면 «셈»이 먼저 망가진다.
    //   ⛔ 문서가 없으면 아무것도 싣지 않는다 → 종전 호출자는 «바이트 동일»하게 흐른다.
    //   ⛔ host 를 여기서 «안다»: 산출물은 이 기계의 루프백에 뜬다(artifact-launcher 계약).
    //     그것을 모르는 층에 기본값으로 두면 「그럴듯한 값」이 된다(리뷰 #10550).
    const deliverableWiring = input.deliverable === undefined
      ? undefined
      : buildDeliverableTargets(
          input.deliverable.document,
          input.goals.map((goal, index) => goal.id ?? String(index)),
          input.deliverable.attribution,
          DELIVERABLE_OBSERVATION_HOST,
        );
    // ⛔ 「안 실었다」의 관측을 «여기서 다시» 찍지 않는다 — 생산자(self-dev.deliverable-wiring)가
    //   이미 이름 있는 사유를 남긴다. 한 사건을 두 곳에서 찍으면 «세는 자»가 두 번 센다(리뷰 #10550).
    const runtimeForObservationCycle = (): OrchestrateRuntime => {
      const verifyDeliverable = createLaunchDeclaredDeliverableVerifier(
        deliverableWiring,
        input.deliverable?.goalPath,
        deps,
      );
      if (deliverableWiring?.wired !== true) return input.runtime;
      return {
        ...input.runtime,
        deliverableTargets: deliverableWiring.targets,
        ...(verifyDeliverable === undefined ? {} : { verifyDeliverable }),
      };
    };
    const runtimeWithParentRequest = (): OrchestrateRuntime => {
      const runtime = runtimeForObservationCycle();
      return input.parentRequest === undefined ? runtime : { ...runtime, parentRequest: input.parentRequest };
    };
    const exec = deps.executeReroute ?? executeOrchestrateReroute;
    const pipelineDeps = deps.pipelineDeps ? { pipelineDeps: deps.pipelineDeps } : undefined;

    let baseRuntime = runtimeWithParentRequest();
    let { results, exitCode } = await exec(spec, baseRuntime, pipelineDeps);

    // ⭐⭐⭐ 런 슈퍼바이저 — 스위치가 켜졌으면 «여기»서 끝까지 돈다.
    //   ⛔ 프로세스를 다시 띄우지 않는다: resumeFrom 심으로 같은 프로세스 안에서 라운드를 돌아야
    //     runId·체크포인트·관측이 한 줄로 이어진다.
    //   ⛔ 판정은 순수 모듈(run-supervisor)이 하고, 이 심은 그 답을 «집행»만 한다.
    if (input.supervise) {
      const limits = {
        ...(input.supervise.rounds === undefined ? {} : { maxRounds: input.supervise.rounds }),
        ...(input.supervise.stallRounds === undefined ? {} : { stallRounds: input.supervise.stallRounds }),
      };
      // ⭐ 루프는 «공용»이다(run-supervisor.superviseRun) — 단일 실행도 같은 자를 쓴다.
      //   ⛔ 여기가 아는 것은 「어떻게 다시 거나」뿐이고, 「걸까 말까」는 그 자가 안다.
      // DRAFT-TRIAGE — a rework round of the same goal opens a new PR; the previous round's draft is superseded.
      let roundPrTracker: ReturnType<typeof createRoundPrTracker> | undefined;
      let supervisedRound = 0;
      const recordRoundPrs = async (rs: readonly SelfDevJobResult[]): Promise<void> => {
        try {
          // Once a PR is tracked, every round runs — an unfinished supersede is retried even without a new PR.
          if (!roundPrTracker && !rs.some((r) => r.prUrl)) return;
          roundPrTracker ??= createRoundPrTracker({
            runId: process.env.ELANOUS_RUN_ID ?? rs.find((r) => r.runId?.trim())?.runId ?? null,
            adapters: deps.roundPrAdapters ?? await defaultRoundPrAdapters(),
          });
          roundPrTracker.record(rs, supervisedRound);
        } catch (error) {
          try { debug.log('self-dev.supervisor', 'round-pr-record-failed', { round: supervisedRound, error: String(error) }); } catch { /* fail-open */ }
        }
      };
      await recordRoundPrs(results);
      results = await superviseRun({
        initial: results,
        limits,
        enrich: (rs) => backfillDecomposeProposals([...rs], deps),
        onDecision: (decision) => {
          currentDecision = decision;
          if (decision.action !== 'add-repair-task') input.supervise!.onDecision?.(decision);
        },
        observe: (event, data) => { try { debug.log('self-dev.supervisor', event, data); } catch { /* fail-open */ } },
        onRound: (rs) => { try { baseRuntime.checkpoint?.([...rs]); } catch { /* fail-open */ } },
        // ⭐ 방금 끝난 결과를 넘긴다 — orchestrateSelfDev 가 classifyResumeDisposition 으로
        //   skip/rerun 을 갈라준다(재발명 0 · 착지한 조각은 다시 안 돈다).
        rerun: async (previous) => {
          let addedRepairIds: string[] = [];
          if (currentDecision?.action === 'add-repair-task') {
            const appended = appendRepairFragments(currentGoals, currentDecision.classifications, {
              seenFingerprints: repairFingerprints,
              addedCount: repairFragmentsAdded,
            });
            currentGoals = appended.goals;
            repairFragmentsAdded += appended.added.length;
            for (const outcome of appended.added) repairFingerprints.set(outcome.fingerprint, (repairFingerprints.get(outcome.fingerprint) ?? 0) + 1);
            repairAppend.push({ added: appended.added, skipped: appended.skipped });
            addedRepairIds = appended.added.map((item) => `repair:${item.fingerprint}`);
            spec = buildSelfOrchestrateDevSpec(currentGoals, input.concurrency);
            if (appended.added.length === 0) {
              currentDecision.why = `${currentDecision.why} — 수리 조각 추가 없음 (${appended.skipped.length}건 건너뜀)`;
            }
            input.supervise!.onDecision?.(currentDecision);
            try {
              debug.log('self-dev.supervisor', 'add-repair-task.applied', {
                added: appended.added.map((outcome) => outcome.fingerprint),
                skipped: appended.skipped.map((outcome) => ({ fingerprint: outcome.fingerprint, reason: outcome.reason })),
                totalAdded: repairFragmentsAdded,
                totalLimit: MAX_REPAIR_FRAGMENTS_TOTAL,
                perFingerprintLimit: MAX_REPAIR_FRAGMENTS_PER_FINGERPRINT,
              });
            } catch { /* fail-open */ }
          }
          // ⭐⭐⭐ 「쪼개서 다시」의 집행 — 단일이 «연합으로 승격»되는 자리.
          //   판정(decompose-and-retry)은 트리아지가 이미 했다. 여기는 그 답을 집행만 한다.
          //   ⛔ 의존성은 조각이 «들고 온 그대로» 물려준다 ⇒ dependsOn 이 없는 조각은
          //     orchestrateSelfDev 의 위상 병렬로 «자동으로 동시에» 돈다(대표 2026-08-19 기본 동작).
          const goalsBeforeDecompose = new Set(currentGoals);
          const applied = applyDecomposeProposals(currentGoals, previous, { alreadyDecomposed: decomposedFeatures });
          if (applied.decomposed.length > 0) {
            for (const f of applied.decomposed) decomposedFeatures.add(f);
            currentGoals = applied.goals;
            spec = buildSelfOrchestrateDevSpec(currentGoals, input.concurrency);
            try {
              // ⛔⭐ 「원본 ↔ 조각」을 «이름»으로 남긴다 — 수만 남기면 그 연결이 «영영» 안 남는다.
              //   📏 2026-08-19 자수: 초판이 decomposed.length 만 실었다. 그러면 나중에
              //     「이 런이 어느 원본에서 쪼개졌나」를 «아무 데서도» 못 가린다.
              //   ⚠️ 그리고 이 값은 «로그»라 보존이 짧다(~2.5시간 실측 · 원장은 15일) —
              //     원장에 싣는 것이 다음 칸이다(🅣 축 · E0).
              debug.log('self-dev.supervisor', 'decompose-and-retry.applied', {
                decomposed: applied.decomposed.length,
                decomposedFeatures: applied.decomposed.map((f) => f.slice(0, 120)),
                pieceFeatures: currentGoals.map((g) => g.feature.slice(0, 80)),
                goalsBefore: previous.length,
                goalsAfter: currentGoals.length,
                parallelReady: currentGoals.filter((g) => !g.dependsOn?.length).length,
              });
            } catch { /* fail-open */ }
          }
          baseRuntime = runtimeWithParentRequest();
          // ⛔⭐ 판정이 「사람이 볼 것」이라 한 조각은 집행이 다시 돌리지 않는다 — 판정과 집행이 갈리면
          //   `pr-opened` 조각이 duplicate-risk 로 재실행돼 PR 이 겹친다(2026-09-25 실측).
          const resumeHold = currentDecision?.needsHuman ?? [];
          // The engine's resume lookup is last-result-wins for each normalized feature.
          // Use that exact predecessor, not any earlier task sharing the same feature.
          const selectedPrior = new Map(previous.map((result) => [resumeKey(result.feature), result.taskId]));
          const strategyByPriorId = new Map<string, 'rerun' | 'rework' | 'decompose-and-retry'>();
          for (const id of currentDecision?.rerunnable ?? []) strategyByPriorId.set(id, 'rerun');
          for (const id of currentDecision?.reworkable ?? []) strategyByPriorId.set(id, 'rework');
          for (const id of currentDecision?.decomposable ?? []) strategyByPriorId.set(id, 'decompose-and-retry');
          const strategyByGoal = new Map<SelfDevGoal, string>();
          for (const goal of currentGoals) {
            const predecessor = selectedPrior.get(resumeKey(goal.feature));
            if (predecessor && strategyByPriorId.has(predecessor)) strategyByGoal.set(goal, strategyByPriorId.get(predecessor)!);
            if (goal.id && addedRepairIds.includes(goal.id)) strategyByGoal.set(goal, 'add-repair-task');
          }
          // Pieces have fresh goal objects; the selected source must actually have been decomposed.
          for (const id of currentDecision?.decomposable ?? []) {
            const source = previous.find((result) => result.taskId === id);
            if (!source || selectedPrior.get(resumeKey(source.feature)) !== id || !applied.decomposed.includes(source.feature)) continue;
            for (const piece of source.decomposeProposal?.pieces ?? []) {
              const goal = currentGoals.find((candidate) => !goalsBeforeDecompose.has(candidate) && candidate.id === piece.id && candidate.feature === piece.feature);
              if (goal) strategyByGoal.set(goal, 'decompose-and-retry');
            }
          }
          const requested = new Map<string, number>();
          for (const strategy of strategyByGoal.values()) requested.set(strategy, (requested.get(strategy) ?? 0) + 1);
          const launchedByStrategy = new Map<string, string[]>();
          const next = await exec(spec, {
            ...baseRuntime, resumeFrom: [...previous], ...(resumeHold.length > 0 ? { resumeHold } : {}),
            onTaskLaunched: (goal, taskId, priorTaskId) => {
              baseRuntime.onTaskLaunched?.(goal, taskId, priorTaskId);
              const strategy = strategyByGoal.get(goal);
              if (!strategy) return;
              if (strategy === 'add-repair-task' && !addedRepairIds.includes(goal.id ?? '')) return;
              if (strategy === 'decompose-and-retry' && goalsBeforeDecompose.has(goal)
                && (priorTaskId === undefined || priorTaskId !== selectedPrior.get(resumeKey(goal.feature)))) return;
              if (strategy !== 'add-repair-task' && strategy !== 'decompose-and-retry'
                && (priorTaskId === undefined || priorTaskId !== selectedPrior.get(resumeKey(goal.feature)))) return;
              const launched = launchedByStrategy.get(strategy) ?? [];
              launched.push(taskId);
              launchedByStrategy.set(strategy, launched);
            },
          }, pipelineDeps);
          // runSelfOrchestrateCliCommand → superviseRun.rerun → executeOrchestrateReroute → orchestrateSelfDev.
          // Only task identities observed at dispatch count; a checkpoint result cannot claim another strategy's launch.
          for (const [strategy, count] of requested) {
            const returnedIds = new Set(next.results.map((result) => result.taskId));
            const taskIds = (launchedByStrategy.get(strategy) ?? []).filter((id) => returnedIds.has(id));
            try {
              debug.log('self-dev.supervisor', 'strategy.launch', {
                strategy, round: supervisedRound + 1, requested: count,
                launched: taskIds.length, taskIds,
              });
            } catch { /* observation must not interrupt execution */ }
          }
          exitCode = next.exitCode;
          supervisedRound += 1;
          await recordRoundPrs(next.results);
          return next.results;
        },
      });
    }

    return { ok: true, results, exitCode, ...(repairAppend.length ? { repairAppend } : {}) };
  } catch (e) {
    return { ok: false, message: String((e as { message?: string })?.message ?? e), exitCode: 1 };
  }
}
