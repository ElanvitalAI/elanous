import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { buildAdRunSetup } from './ad-run-setup.js';
import type { Intake } from './intake.js';
import {
  DRAFT_MARKER,
  resolveAdMode,
  validateDraftMarkerPlan,
  type AdMode,
  type AdModeDefinition,
  type DraftMarker,
} from './mode.js';
import {
  GENERATED_ASSET_DISCLOSURE,
  hasWiredGeneratedProduction,
  resolveAssetProvenance,
  requiresGeneratedAssetDisclosure,
  validateProvenancePlan,
  type AssetProvenance,
  type GeneratedAssetDisclosure,
} from './provenance.js';
import { evaluateGrounding, formatVerdict, type GroundingVerdict, type PageFacts } from '../product-grounding/checklist.js';
import { createConcept, type ConceptGenerator, type ConceptResult } from './concept.js';
import { parseSkillOutput } from './skill-bridge.js';
import { surveyMarket, type OmniCrawlSurveyCollector, type SurveyRequest, type SurveyResult } from './survey.js';
import { assessProductionReadiness, type ProductionReadinessInput, type StepReadiness } from './production.js';
import { runShootPlan, type ShootBackend, type ShootOutcome, type ShootRunOptions, type ShootRunResult } from './shoot-run.js';
import { buildShootPlan, type DurationRule, type ReferenceDelivery } from './shoot-plan.js';
import type { CommandRunner } from './higgsfield-backend.js';
import { buildAssemblyPlan, type AssemblyOptions, type ClipFile, type MasterAudioSource } from './assemble.js';
import { buildClipProbePlan, materializeClipFiles, type ClipProbeOutputs } from './clip-materialize.js';
import { buildRetainPlan, type BuildRetainPlanOptions, type RemoteAsset } from './retain.js';
import type { SceneSpec } from './scene-spec.js';
import { buildSoundPlan, type VoiceLine } from './sound-plan.js';
import { buildCaptionPlan, type CaptionPlan, type ElevenLabsCharacterAlignment } from './caption-plan.js';
import { buildCaptionRenderPlan, CAPTION_BOTTOM_FRACTION } from './caption-render.js';
import { buildQcMeasurementPlan, parseQcMeasurements, shouldRunQcMeasurementCommand, textRegionUnavailableReason, type QcMeasurementOutputs, type QcMeasurementStep } from './qc-measure.js';
import { assessCaptionedQc, assessQc, worstVerdict, type QcFinding, type QcMeasurements, type QcResult, type QcThresholds } from './qc.js';
import { debug } from '../debug/log.js';
import { GRAPH_SPECS, GRAPH_TEMPLATES, GRAPH_TEMPLATES_ISSUES, GRAPH_TEMPLATES_SOURCE, pipelineNodeEntryPayload } from '../self-implement/graph-templates.js';

/**
 * ⛔ 앞쪽 칸(`survey`⊕`concept`)은 «선택»이다 — 그것을 «필수»로 만들면
 *    이미 도는 입구 셋(CLI·TUI·텔레그램)이 전부 `blocked` 로 접힌다.
 *    📏 2026-09-10 실측: 필수로 만든 판이 기존 시험 «7개»를 빨갛게 했다.
 * 🔑 그래서 게이트 목록이 «둘»이다 — 앞쪽을 부탁했을 때만 `CONCEPT_OK` 가 «생긴다».
 */
export const AD_GATES = ['BRIEF_OK', 'MASTER_PICK', 'PACK_OK', 'VIDEO_OK'] as const;
export const AD_GATES_WITH_FRONT = ['CONCEPT_OK', ...AD_GATES] as const;
export type AdFrontGate = 'CONCEPT_OK';
export type AdGate = typeof AD_GATES_WITH_FRONT[number];

type AdGraphTransition =
  | { readonly gate: AdGate; readonly outcome: 'pass' | 'fail' }
  | { readonly from: 'survey'; readonly outcome: 'candidate' | 'empty' | 'unknown' }
  | { readonly from: 'select' };

function observeAdGraphEntry(adRunId: string, transition: AdGraphTransition): void {
  try {
    const template = GRAPH_TEMPLATES['ad-loop'];
    if (template === undefined) {
      debug.log('ad-pipeline.graph', 'pipeline-node-entry-measurement-failed', {
        adRunId,
        ...transition,
        reason: 'ad-loop graph template unavailable',
        graphTemplatesSource: GRAPH_TEMPLATES_SOURCE,
        graphTemplateIssues: GRAPH_TEMPLATES_ISSUES,
      });
      return;
    }
    const edge = 'gate' in transition
      ? GRAPH_SPECS['ad-loop']?.edges.find((candidate) => candidate.on === transition.gate)
      : GRAPH_SPECS['ad-loop']?.edges.find((candidate) => candidate.from === transition.from);
    const node = edge === undefined
      ? undefined
      : 'gate' in transition ? edge.map?.[transition.outcome] : 'outcome' in transition ? edge.map?.[transition.outcome] : edge.to;
    if (node === undefined) {
      debug.log('ad-pipeline.graph', 'pipeline-node-entry-measurement-failed', {
        adRunId,
        ...transition,
        reason: 'ad-loop graph transition has no declared destination',
        graphTemplatesSource: GRAPH_TEMPLATES_SOURCE,
      });
      return;
    }
    debug.log('ad-pipeline.graph', 'pipeline-node-entry', {
      ...pipelineNodeEntryPayload(template, node),
      node,
      adRunId,
      ...transition,
      graphTemplatesSource: GRAPH_TEMPLATES_SOURCE,
    });
  } catch (error) {
    try {
      debug.log('ad-pipeline.graph', 'pipeline-node-entry-measurement-failed', {
        adRunId,
        ...transition,
        reason: error instanceof Error ? error.message : String(error),
      });
    } catch { /* 관측 실패 기록도 파이프라인을 중단하지 않는다 */ }
  }
}

function observeAdGraphGateEntry(adRunId: string, gate: AdGate, outcome: 'pass' | 'fail'): void {
  observeAdGraphEntry(adRunId, { gate, outcome });
}

function surveyObservationOutcome(error: unknown): 'empty' | 'unknown' {
  return error instanceof Error && error.message === 'Survey collection returned no evidence-backed candidates.' ? 'empty' : 'unknown';
}
export type { AssetProvenance } from './provenance.js';

/**
 * ⛔ 「못 쟀다」는 「깨끗하다」가 «아니다».
 * 접지는 aside(사람의 실제 브라우저)를 요구한다 — 그것이 없으면 판정을 «안 한 것»이지
 * 통과한 것이 아니다. 그래서 두 상태를 다른 값으로 둔다.
 */
export type GroundingOutcome =
  | { readonly status: 'evaluated'; readonly verdict: GroundingVerdict; readonly summary: string }
  | { readonly status: 'not-collected'; readonly reason: string };

export const GROUNDING_COLLECTOR_MISSING =
  '접지 수집기가 없어 판정을 «못 쟀다» — 「깨끗하다」가 아니다. aside 브라우저가 있어야 한다.';

export interface AdPipelinePlan {
  readonly intake: Intake;
  readonly provenance: AssetProvenance;
  readonly grounding?: GroundingOutcome;
  readonly disclosure?: GeneratedAssetDisclosure;
  readonly mode: AdMode;
  readonly modeDefinition: AdModeDefinition;
  readonly draftMarker?: DraftMarker;
  readonly stages: readonly AdGate[];
  readonly survey?: SurveyResult;
  readonly concept?: ConceptResult;
  readonly sceneWarnings?: readonly string[];
  /** Parser feedback for caller-supplied shot markdown that could not produce a scene. */
  readonly shotParse?: { readonly missing: readonly string[]; readonly formatMismatch?: string };
  /** The selected scene records whether production used a generated concept scene, a caller injection, or both. */
  readonly productionScene?: { readonly selected: 'concept' | 'assembly'; readonly sources: 'concept' | 'assembly' | 'both' };
  /** The selected voiceover records its source and names a missing runner instead of silently dropping selected lines. */
  readonly productionVoiceover?: {
    readonly selected: 'concept' | 'production';
    readonly sources: 'concept' | 'production' | 'both';
    readonly nonExecutionReason?: 'voiceover-runner-missing';
  };
  /** The invariant source distinguishes the generated concept result from an explicit production override. */
  readonly productionInvariants?: { readonly selected: 'concept' | 'production'; readonly sources: 'concept' | 'production' | 'both' };
  /** Names why a master was intentionally assembled without a soundtrack. */
  readonly masterAudioReason?: 'no-sound-plan-output' | 'caller-selected-silent-master-audio';
  /**
   * ⛔ 이 계획을 «실행하려면» 먼저 채워야 하는 것. 비어 있지 않으면 실행은 blocked 된다.
   * 🔑 계획만 보고 「이대로 돌겠구나」로 읽히면 안 된다 — 그것도 「한 일보다 많이 주장하기」다.
   */
  readonly prerequisites: readonly string[];
  /** ⛔ 이 진입이 «아직 부르지 않는» 제작 단계 — 계획 단계에서부터 이름으로 말한다. */
  readonly unwiredProduction: readonly ProductionStep[];
  /** 각 단계가 왜 아직 실행 불가한지(또는 어떤 주입으로 준비됐는지)를 보존한다. */
  readonly productionReadiness: readonly StepReadiness[];
}

/** ⛔ 이것을 «주었을 때만» 앞쪽 칸이 돈다. 안 주면 파이프라인은 오늘까지와 «똑같이» 돈다. */
export interface AdFrontStageInput {
  readonly survey: SurveyRequest;
  readonly selection?: string;
  readonly skuGrounding?: { readonly specRows: Readonly<Record<string, string>>; readonly legalStatus?: string };
  readonly shotMarkdown?: string;
  readonly voiceId?: string;
}

export interface AssemblyProductionInput {
  /** An explicit caller scene takes precedence over the optional generated concept scene. */
  readonly scene?: SceneSpec;
  /** Explicit clips take precedence over clips retained from a successful shoot. */
  readonly clips?: readonly ClipFile[];
  /** Explicit caller options take precedence over output identity defaults. */
  readonly options?: AssemblyOptions;
  /** Omitted audio remains silent; explicit original and soundtrack selections reach buildAssemblyPlan. */
  readonly masterAudio?: MasterAudioSource;
}

export interface AssemblyMaterialsInput {
  /** Explicit clips take precedence over clips retained from a successful shoot. */
  readonly clips?: readonly ClipFile[];
  /** Explicit caller options take precedence over output identity defaults. */
  readonly options?: AssemblyOptions;
  readonly masterAudio?: MasterAudioSource;
}

export interface ShootClipRetention {
  readonly options: BuildRetainPlanOptions;
  readonly runner: CommandRunner;
}

export interface AdProductionDeps {
  readonly ground?: PageFacts;
  readonly invariants?: ConceptResult;
  readonly cut?: ShootBackend;
  readonly durationRules?: Readonly<Record<string, DurationRule>>;
  readonly creditsPerSecond?: Readonly<Record<string, number>>;
  readonly referenceAssets?: Readonly<Record<string, readonly string[]>>;
  readonly referenceDelivery?: Readonly<Record<string, ReferenceDelivery>>;
  readonly shootRunOptions?: ShootRunOptions;
  /** Retains and probes successful Higgsfield shots when assembly clips are not supplied explicitly. */
  readonly shootClipRetention?: ShootClipRetention;
  readonly voiceover?: {
    readonly lines: readonly VoiceLine[];
    readonly runner?: CommandRunner;
  };
  readonly soundtrack?: CommandRunner;
  /** Caller-supplied music bed; the pipeline never infers a conventional filename. */
  readonly musicBedPath?: string;
  /** Explicit font for caption rendering; without it, a caption plan is blocked rather than silently skipped. */
  readonly captionFontPath?: string;
  readonly clips?: {
    readonly runner: CommandRunner;
    readonly workDir: string;
  };
  /** Existing caller-supplied assembly materials; its optional explicit scene remains the highest-priority scene channel. */
  readonly assembly?: AssemblyProductionInput;
  /** Materials can be supplied independently so a generated concept scene can reach assembly without a caller scene. */
  readonly assemblyMaterials?: AssemblyMaterialsInput;
  readonly render?: CommandRunner;
  /** Optional calibrated thresholds; omitted thresholds intentionally preserve unmeasured QC findings. */
  readonly qcThresholds?: QcThresholds;
  /** Platform that decides whether on-screen text OCR (macOS Vision via swiftc) is planned; defaults to `process.platform`. */
  readonly qcPlatform?: NodeJS.Platform;
}

export interface AdOutputIdentity {
  readonly slug: string;
  readonly version: number;
  readonly aspect: string;
  readonly home?: string;
  readonly date?: string;
}

export interface AdPipelineDeps {
  readonly approve: (gate: AdGate, plan: AdPipelinePlan) => boolean | Promise<boolean>;
  readonly stage: (gate: AdGate, plan: AdPipelinePlan) => void | Promise<void>;
  readonly onGrounding: (outcome: GroundingOutcome) => void | Promise<void>;
  readonly collectPageFacts?: (url: string) => PageFacts | Promise<PageFacts>;
  readonly frontStage?: AdFrontStageInput;
  readonly collectSurvey?: OmniCrawlSurveyCollector;
  readonly selectSurveyCandidate?: (survey: SurveyResult) => string | Promise<string>;
  readonly generateConcept?: ConceptGenerator;
  readonly production?: AdProductionDeps;
  readonly outputSetupError?: string;
  readonly mode?: AdMode;
}

/**
 * 접지 뒤에 오는 «제작» 단계들 — 지금은 전부 셸 절차이고 이 진입이 «부르지 않는다».
 * ⛔ 이름을 여기 두는 이유: 안 부르는 것을 «안 부른다고» 말할 수 있어야 하기 때문이다.
 */
export const PRODUCTION_STEPS = ['ground', 'invariants', 'expand', 'cut', 'voiceover', 'soundtrack', 'render'] as const;
export type ProductionStep = typeof PRODUCTION_STEPS[number];

/**
 * ⛔ `completed` 라는 값을 «두지 않는다`.
 * 게이트를 다 통과해도 제작은 «아직 안 했다» — 그것을 `completed` 라 부르면
 * 상태값이 거짓말을 하고, 부르는 쪽이 「영상이 나왔다」로 읽는다.
 */
export type AdPipelineResult =
  /** 접지를 «못 쟀다» ⇒ 게이트를 묻지도 않는다. 사람의 승인을 헛되이 쓰지 않는다. */
  | { readonly status: 'blocked'; readonly plan: AdPipelinePlan; readonly grounding: GroundingOutcome; readonly reason: string }
  | { readonly status: 'rejected'; readonly plan: AdPipelinePlan; readonly stoppedGate: AdGate; readonly grounding?: GroundingOutcome }
  /** 게이트는 전부 통과했다. ⛔ 「만들었다」가 «아니다» — 아래 단계가 아직 배선 안 됐다. */
  | {
    readonly status: 'gates-approved';
    readonly plan: AdPipelinePlan;
    readonly grounding?: GroundingOutcome;
    readonly unwiredProduction: readonly ProductionStep[];
    readonly productionReadiness: readonly StepReadiness[];
    /** Present only when the injected shooting dependencies produced a shoot run. */
    readonly shootRun?: ShootRunResult;
    /** Per-beat shooting results, including unsettled polling context for caller recovery. */
    readonly shootAssets?: readonly ShootAssetResult[];
    /** Present when a shoot-plan beat has no configured credit rate. */
    readonly unpriced?: readonly { readonly beatIndex: number; readonly name: string; readonly reason: string }[];
    /** Present when assembly resolves a clip trim that differs from the scene duration. */
    readonly trimDisagreement?: readonly { readonly beatIndex: number; readonly clip: number; readonly scene: number }[];
    /** Present only when clip materialization ran; lists beats whose probe could not be measured. */
    readonly unprobedClipBeats?: readonly number[];
    /** Present when assembly is blocked, retaining the plan's named reasons for caller recovery. */
    readonly blocked?: readonly string[];
    /** Present when assembly is blocked, retaining the clips already created for caller recovery. */
    readonly clips?: readonly ClipFile[];
    /** Present only when assembly produced a master. */
    readonly masterPath?: string;
    /** Present only when vertical assembly produced a safezone frame. */
    readonly safezonePath?: string;
    /** Present after sound processing when voiceover alignments were planned into captions. */
    readonly captionPlan?: CaptionPlan;
    /** Present only after caption rendering successfully created a separate, captioned delivery master. */
    readonly captionedMasterPath?: string;
    /** Present when caption rendering was skipped or failed, while masterPath remains available for recovery. */
    readonly captionBlocked?: readonly string[];
    /** Present only after a successfully assembled master has been measured and assessed. */
    readonly qc?: QcResult;
  };

/**
 * 사람이 aside 로 모아 건네준 접지 사실을 «검사»한다.
 * ⛔⭐ 가장 위험한 것은 «다른 상품의 사실»이다 — 그것으로 접지하면 광고가 «있지도 않은 제품»을
 *    사실이라 말한다(허위 표시). 그래서 URL 일치를 «강제»한다.
 * ⛔ 그리고 모양이 안 맞으면 여기서 «이름을 대고» 거절한다 — 체크리스트가 런타임 예외로 죽지 않게.
 */
export function parseGroundingFacts(raw: unknown, expectedUrl: string): { ok: true; facts: PageFacts } | { ok: false; reason: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, reason: '접지 사실이 객체가 아니다.' };
  const o = raw as Record<string, unknown>;
  if (typeof o.url !== 'string') return { ok: false, reason: '접지 사실에 url 문자열이 없다.' };
  if (o.url !== expectedUrl) {
    return { ok: false, reason: `접지 사실이 «다른 주소»의 것이다 — 요청=${expectedUrl} · 사실=${o.url}` };
  }
  if (typeof o.title !== 'string') return { ok: false, reason: '접지 사실에 title 문자열이 없다.' };
  // ⛔ 「배열이다」는 「문자열 배열이다」가 «아니다». 원소까지 안 보면 체크리스트가
  //    숫자·null 을 문자열로 다뤄 조용히 틀린 사실을 쓴다.
  for (const key of ['nameCandidates', 'priceCandidates'] as const) {
    const value = o[key];
    if (!Array.isArray(value)) return { ok: false, reason: `접지 사실의 ${key} 가 배열이 아니다.` };
    if (value.some((item) => typeof item !== 'string')) {
      return { ok: false, reason: `접지 사실의 ${key} 에 문자열이 아닌 원소가 있다.` };
    }
  }
  if (!Array.isArray(o.images)) return { ok: false, reason: '접지 사실의 images 가 배열이 아니다.' };
  for (const image of o.images) {
    if (!image || typeof image !== 'object' || Array.isArray(image)) {
      return { ok: false, reason: '접지 사실의 images 원소가 객체가 아니다.' };
    }
    const { src, w, h } = image as Record<string, unknown>;
    if (typeof src !== 'string' || typeof w !== 'number' || typeof h !== 'number' || !Number.isFinite(w) || !Number.isFinite(h)) {
      return { ok: false, reason: '접지 사실의 images 원소는 { src: 문자열, w: 수, h: 수 } 여야 한다.' };
    }
  }
  if (!o.specRows || typeof o.specRows !== 'object' || Array.isArray(o.specRows)) {
    return { ok: false, reason: '접지 사실의 specRows 가 「키 → 값」 객체가 아니다.' };
  }
  if (Object.values(o.specRows as Record<string, unknown>).some((value) => typeof value !== 'string')) {
    return { ok: false, reason: '접지 사실의 specRows 에 문자열이 아닌 값이 있다.' };
  }
  return { ok: true, facts: raw as PageFacts };
}

export const GROUNDING_PREREQUISITE =
  '판매 URL 갈래는 접지 사실이 있어야 실행된다 — aside 로 모아 `--facts <path>` 로 준다(매뉴얼 §H①).';

function protectDraftMarker(plan: AdPipelinePlan): AdPipelinePlan {
  if (plan.mode === 'quick') {
    Object.defineProperty(plan, 'draftMarker', {
      value: DRAFT_MARKER,
      enumerable: true,
      writable: false,
      configurable: false,
    });
  }
  return plan;
}

function attachGrounding(plan: AdPipelinePlan, grounding: GroundingOutcome): void {
  Object.defineProperty(plan, 'grounding', {
    value: grounding,
    enumerable: true,
    writable: false,
    configurable: false,
  });
}

function validateAdPipelineModePlan(plan: AdPipelinePlan, requestedMode: AdMode): void {
  if (plan.mode !== requestedMode || plan.modeDefinition.mode !== requestedMode) {
    throw new Error(`Ad pipeline mode mismatch: requested ${requestedMode}, planned ${plan.mode}.`);
  }
  validateDraftMarkerPlan({ mode: requestedMode, draftMarker: plan.draftMarker });
}

function productionReadinessFor(production: AdProductionDeps | undefined, scene?: SceneSpec, concept?: ConceptResult): ProductionReadinessInput {
  const conceptVoiceover = concept?.voiceover;
  const conceptVoiceLines = conceptVoiceover && 'lines' in conceptVoiceover ? conceptVoiceover.lines : undefined;
  const assemblyMaterials = production?.assemblyMaterials ?? production?.assembly;
  const assemblyDependencies = assemblyMaterials
    ? ['render command runner', 'assembly scene']
    : ['render command runner', 'assembly materials', 'assembly scene'];
  return {
    dependencies: {
      ground: ['page facts'],
      invariants: ['concept result'],
      cut: ['shoot backend', 'duration rules', 'credits per second', 'reference assets', 'reference delivery', 'production scene'],
      voiceover: ['voice lines', 'voice command runner'],
      soundtrack: ['sound command runner'],
      render: assemblyDependencies,
    },
    supplied: [
      ...(production?.ground ? ['page facts'] : []),
      ...(production?.invariants || concept ? ['concept result'] : []),
      ...(production?.cut ? ['shoot backend'] : []),
      ...(production?.durationRules ? ['duration rules'] : []),
      ...(production?.creditsPerSecond ? ['credits per second'] : []),
      ...(production?.referenceAssets ? ['reference assets'] : []),
      ...(production?.referenceDelivery ? ['reference delivery'] : []),
      ...(production?.voiceover?.lines.length || conceptVoiceLines?.length ? ['voice lines'] : []),
      ...(production?.voiceover?.runner ? ['voice command runner'] : []),
      ...(production?.soundtrack ? ['sound command runner'] : []),
      ...(production?.render ? ['render command runner'] : []),
      ...(production?.assemblyMaterials || production?.assembly ? ['assembly materials'] : []),
      ...(scene ? ['assembly scene', 'production scene'] : []),
    ],
  };
}

function assessProductionFor(production: AdProductionDeps | undefined, scene?: SceneSpec, concept?: ConceptResult): readonly StepReadiness[] {
  return assessProductionReadiness(productionReadinessFor(production, scene, concept));
}

function unwiredProductionFor(readiness: readonly StepReadiness[]): readonly ProductionStep[] {
  return readiness
    .filter((step) => step.status !== 'wired')
    .map((step) => step.step);
}

function productionReadinessCounts(readiness: readonly StepReadiness[]): Record<'wired' | 'needsInput' | 'unwired', number> {
  return readiness.reduce<Record<'wired' | 'needsInput' | 'unwired', number>>(
    (counts, step) => ({
      ...counts,
      [step.status === 'needs-input' ? 'needsInput' : step.status]: counts[step.status === 'needs-input' ? 'needsInput' : step.status] + 1,
    }),
    { wired: 0, needsInput: 0, unwired: 0 },
  );
}

function productionSceneFor(concept: ConceptResult | undefined, production: AdProductionDeps | undefined): {
  readonly scene?: SceneSpec;
  readonly provenance?: AdPipelinePlan['productionScene'];
} {
  const conceptScene = concept?.scene;
  const assemblyScene = production?.assembly?.scene;
  if (assemblyScene) {
    return {
      scene: assemblyScene,
      provenance: { selected: 'assembly', sources: conceptScene ? 'both' : 'assembly' },
    };
  }
  if (conceptScene) return { scene: conceptScene, provenance: { selected: 'concept', sources: 'concept' } };
  return {};
}

function productionInvariantsFor(concept: ConceptResult | undefined, production: AdProductionDeps | undefined): AdPipelinePlan['productionInvariants'] {
  if (production?.invariants) {
    return { selected: 'production', sources: concept ? 'both' : 'production' };
  }
  return concept ? { selected: 'concept', sources: 'concept' } : undefined;
}

function productionVoiceoverFor(concept: ConceptResult | undefined, production: AdProductionDeps | undefined): {
  readonly voiceover?: NonNullable<AdProductionDeps['voiceover']>;
  readonly provenance?: AdPipelinePlan['productionVoiceover'];
} {
  const productionVoiceover = production?.voiceover;
  const productionLines = productionVoiceover?.lines;
  const conceptVoiceover = concept?.voiceover;
  const conceptLines = conceptVoiceover && 'lines' in conceptVoiceover ? conceptVoiceover.lines : undefined;
  const selected = productionLines?.length ? 'production' : conceptLines?.length ? 'concept' : undefined;
  if (!selected) return {};
  const lines = selected === 'production' ? productionLines! : conceptLines!;
  return {
    voiceover: { lines, ...(productionVoiceover?.runner ? { runner: productionVoiceover.runner } : {}) },
    provenance: {
      selected,
      sources: productionLines?.length && conceptLines?.length ? 'both' : selected,
      ...(productionVoiceover?.runner ? {} : { nonExecutionReason: 'voiceover-runner-missing' as const }),
    },
  };
}

interface ShootingRunResult {
  readonly shootRun: ShootRunResult;
  readonly unpriced: readonly { readonly beatIndex: number; readonly name: string; readonly reason: string }[];
}

export function unpricedReason(
  plan: ReturnType<typeof buildShootPlan>,
  scene: SceneSpec,
  durationRules: Readonly<Record<string, DurationRule>>,
  beatIndex: number,
): string {
  const beatToken = new RegExp(`(?:^|:)beat-${beatIndex + 1}(?:$|:)`);
  const blocked = plan.blocked.find((reason) => beatToken.test(reason));
  if (blocked !== undefined) return blocked;
  const planBlocked = plan.blocked.find((reason) => (
    reason.startsWith('mode-cut-limit-exceeded:') || reason === 'invalid-min-generatable-seconds'
  ));
  if (planBlocked !== undefined) return planBlocked;
  const beat = scene.beats[beatIndex];
  if (beat !== undefined && durationRules[beat.model] === undefined) {
    return `No duration rule is configured for ${beat.model}.`;
  }
  const command = plan.commands.find((candidate) => candidate.beatIndex === beatIndex);
  if (command !== undefined && command.estimatedCredits === undefined) return `No credit rate is configured for ${command.jobType}.`;
  return 'Unable to calculate a shoot estimate for this beat.';
}

async function runShooting(production: AdProductionDeps | undefined, scene: SceneSpec | undefined, mode: AdMode): Promise<ShootingRunResult | undefined> {
  if (!production?.cut || !scene || !production.durationRules || !production.creditsPerSecond || !production.referenceAssets || !production.referenceDelivery) {
    return undefined;
  }
  const durationRules = production.durationRules;
  const plan = buildShootPlan(scene, {
    mode,
    durationRules,
    creditsPerSecond: production.creditsPerSecond,
    referenceAssets: production.referenceAssets,
    referenceDelivery: production.referenceDelivery,
  });
  return {
    shootRun: await runShootPlan(plan, production.cut, production.shootRunOptions),
    unpriced: plan.unpriced.map((beatIndex) => ({
      beatIndex,
      name: `Beat ${beatIndex + 1}`,
      reason: unpricedReason(plan, scene, durationRules, beatIndex),
    })),
  };
}

type ShootPollingContext = Pick<ShootOutcome, 'limitedBy' | 'pollingLimits' | 'unobservedPolling'>;

export type ShootAssetResult = Pick<ShootOutcome, 'beatIndex' | 'jobId' | 'resultUrl' | 'failure' | 'unknownStatus'> & ShootPollingContext;

type ShootAsset = RemoteAsset & ShootPollingContext;

function shootPollingContext(outcome: ShootOutcome): ShootPollingContext {
  const { limitedBy, pollingLimits, unobservedPolling } = outcome;
  return {
    ...(limitedBy === undefined ? {} : { limitedBy }),
    ...(pollingLimits === undefined ? {} : { pollingLimits }),
    ...(unobservedPolling === undefined ? {} : { unobservedPolling }),
  };
}

function shootAssetResults(shootRun: ShootRunResult): readonly ShootAssetResult[] {
  return shootRun.outcomes.map((outcome) => {
    const { beatIndex, jobId, resultUrl, failure, unknownStatus } = outcome;
    return {
      beatIndex,
      ...(jobId === undefined ? {} : { jobId }),
      ...(resultUrl === undefined ? {} : { resultUrl }),
      ...(failure === undefined ? {} : { failure }),
      ...(unknownStatus === undefined ? {} : { unknownStatus }),
      ...shootPollingContext(outcome),
    };
  });
}

function successfulShootAssets(shootRun: ShootRunResult): readonly ShootAsset[] {
  return shootRun.outcomes.flatMap((outcome) => outcome.resultUrl
    ? [{
      beatIndex: outcome.beatIndex,
      vendor: 'higgsfield' as const,
      url: outcome.resultUrl,
      ...shootPollingContext(outcome),
    }]
    : []);
}

interface MaterializedShootClips {
  readonly clips: readonly ClipFile[];
  readonly unprobed: readonly number[];
}

class PostShootFailure extends Error {
  constructor(
    readonly stage: string,
    message: string,
    readonly clips?: readonly ClipFile[],
    readonly unprobedClipBeats?: readonly number[],
  ) {
    super(message);
  }
}

function materializeRetainedClips(
  retainPlan: ReturnType<typeof buildRetainPlan>,
  commands: readonly (typeof retainPlan.commands)[number][],
  outputs: ClipProbeOutputs,
): MaterializedShootClips {
  return materializeClipFiles({ ...retainPlan, commands }, outputs);
}

async function materializeSuccessfulShootClips(
  shootRun: ShootRunResult | undefined,
  retention: ShootClipRetention | undefined,
): Promise<MaterializedShootClips | undefined> {
  if (!shootRun || !retention) return undefined;
  const retainPlan = buildRetainPlan(successfulShootAssets(shootRun), retention.options);
  if (retainPlan.blocked.length > 0) throw new PostShootFailure('clip-retention', `Clip retention blocked: ${retainPlan.blocked.join(' ')}`);
  const downloaded: (typeof retainPlan.commands)[number][] = [];
  for (const command of retainPlan.commands) {
    try {
      const result = await retention.runner.run(command.download);
      if (result.exitCode !== 0) throw new Error(result.stderr || `Clip download for beat ${command.beatIndex} failed with exit code ${result.exitCode}.`);
      downloaded.push(command);
    } catch (error) {
      const materialized = materializeRetainedClips(retainPlan, downloaded, {});
      const message = error instanceof Error ? error.message : String(error);
      throw new PostShootFailure('clip-download', `Clip download for beat ${command.beatIndex + 1} failed: ${message}`, materialized.clips, materialized.unprobed);
    }
  }
  const outputs: Record<number, ClipProbeOutputs[number]> = {};
  for (const command of buildClipProbePlan(retainPlan).commands) {
    try {
      const result = await retention.runner.run(command.argv);
      outputs[command.beatIndex] = { ok: result.exitCode === 0, stdout: result.stdout };
    } catch (error) {
      const materialized = materializeRetainedClips(retainPlan, downloaded, outputs);
      throw new PostShootFailure('clip-probe', error instanceof Error ? error.message : String(error), materialized.clips, materialized.unprobed);
    }
  }
  return materializeClipFiles(retainPlan, outputs);
}

function postShootFailure(stage: string, error: unknown, materialized?: MaterializedShootClips): PostShootFailure {
  if (error instanceof PostShootFailure) return error;
  return new PostShootFailure(
    stage,
    error instanceof Error ? error.message : String(error),
    materialized?.clips,
    materialized?.unprobed,
  );
}

function suppliedAssemblyClips(production: AdProductionDeps | undefined): readonly ClipFile[] | undefined {
  return (production?.assemblyMaterials ?? production?.assembly)?.clips;
}

interface SoundPlanRunResult {
  readonly captionPlan: CaptionPlan;
  readonly soundtrackPath?: string;
}

async function runSoundPlan(production: AdProductionDeps | undefined, scene: SceneSpec | undefined): Promise<SoundPlanRunResult | undefined> {
  const voiceover = production?.voiceover;
  const soundtrack = production?.soundtrack;
  const workDir = production?.clips?.workDir;
  const musicBedPath = production?.musicBedPath;
  if (!voiceover?.runner || !soundtrack || !workDir || !scene) return undefined;
  if (voiceover.lines.length === 0) return { captionPlan: buildCaptionPlan(scene, []) };

  const firstPlan = buildSoundPlan(scene, voiceover.lines, { workDir, totalSeconds: scene.axes.totalSeconds, musicBedPath });
  if (firstPlan.blocked.length > 0) throw new Error(`Sound plan blocked: ${firstPlan.blocked.join(' ')}`);
  const alignmentPaths: string[] = [];
  let measurement: string | undefined;
  for (const command of firstPlan.commands) {
    if (command.step === 'duck-mix') continue;
    const result = await (command.step === 'tts' ? voiceover.runner : soundtrack).run(command.argv);
    if (command.step === 'loudnorm-measure') {
      if (result.exitCode === 0) measurement = result.stderr;
      continue;
    }
    if (result.exitCode !== 0) throw new Error(result.stderr || `Sound ${command.step} failed with exit code ${result.exitCode}.`);
    const alignmentOutput = command.outputs?.find((output) => output.name === 'wordAlignment');
    if (alignmentOutput) alignmentPaths.push(alignmentOutput.path);
  }
  const alignments = await Promise.all(alignmentPaths.map(async (path) => {
    try {
      return JSON.parse(await Bun.file(path).text()) as ElevenLabsCharacterAlignment;
    } catch {
      return undefined;
    }
  }));
  const captionPlan = buildCaptionPlan(scene, voiceover.lines.map((line, index) => ({ beatIndex: line.beatIndex, alignment: alignments[index] })));

  const secondPlan = buildSoundPlan(scene, voiceover.lines, {
    workDir,
    totalSeconds: scene.axes.totalSeconds,
    musicBedPath,
    ...(measurement ? { loudnormMeasurement: measurement } : {}),
  });
  if (secondPlan.blocked.length > 0) throw new Error(`Sound plan blocked: ${secondPlan.blocked.join(' ')}`);
  const duckMix = secondPlan.commands.find((command) => command.step === 'duck-mix');
  if (duckMix === undefined) throw new Error('Sound plan did not include duck-mix.');
  const result = await soundtrack.run(duckMix.argv);
  if (result.exitCode !== 0) throw new Error(result.stderr || `Sound duck-mix failed with exit code ${result.exitCode}.`);
  return { captionPlan, soundtrackPath: duckMix.output };
}

interface AssemblyRunResult {
  /** Present only when assembly produced a master. */
  readonly masterPath?: string;
  /** Present only when vertical assembly produced a safezone frame. */
  readonly safezonePath?: string;
  /** Present when assembly is blocked, retaining the plan's named reasons for caller recovery. */
  readonly blocked?: readonly string[];
  /** Present when assembly is blocked, retaining the clips already created for caller recovery. */
  readonly clips?: readonly ClipFile[];
  readonly unprobedClipBeats?: readonly number[];
  readonly trimDisagreement?: readonly { readonly beatIndex: number; readonly clip: number; readonly scene: number }[];
}

async function runAssembly(
  production: AdProductionDeps | undefined,
  scene: SceneSpec | undefined,
  materialized: MaterializedShootClips | undefined,
  soundtrackPath?: string,
): Promise<AssemblyRunResult | undefined> {
  const assembly = production?.assemblyMaterials ?? production?.assembly;
  if (!assembly || !assembly.options || !production?.render || !scene) return undefined;
  const clips = assembly.clips ?? materialized?.clips;
  if (!clips || clips.length === 0) {
    return materialized ? { unprobedClipBeats: materialized.unprobed } : undefined;
  }
  if (materialized?.unprobed.length === clips.length) {
    return { unprobedClipBeats: materialized.unprobed };
  }
  const masterAudio = assembly.masterAudio ?? assembly.options.masterAudio ?? (soundtrackPath ? { kind: 'soundtrack' as const, path: soundtrackPath } : undefined);
  const assemblyOptions: AssemblyOptions = {
    ...assembly.options,
    ...(masterAudio ? { masterAudio } : {}),
  };
  const plan = buildAssemblyPlan(scene, clips, assemblyOptions);
  if (plan.blocked.length > 0) {
    return {
      blocked: plan.blocked,
      clips,
      ...(materialized ? { unprobedClipBeats: materialized.unprobed } : {}),
    };
  }
  for (const command of plan.commands) {
    try {
      const result = await production.render.run(command.argv);
      if (result.exitCode !== 0) throw new Error(result.stderr || `Assembly ${command.step} failed with exit code ${result.exitCode}.`);
    } catch (error) {
      throw new PostShootFailure('assembly-render', error instanceof Error ? error.message : String(error), clips, materialized?.unprobed);
    }
  }
  return {
    masterPath: plan.masterPath,
    ...(plan.safezonePath ? { safezonePath: plan.safezonePath } : {}),
    trimDisagreement: plan.trimDisagreement,
    ...(materialized ? { unprobedClipBeats: materialized.unprobed } : {}),
  };
}

export function assessCaptionScreens(
  measurements: QcMeasurements,
  captionPlan: CaptionPlan | undefined,
  thresholds: QcThresholds | undefined,
): QcFinding {
  if (!captionPlan) {
    return { name: 'caption-lines', verdict: 'unmeasured', reason: 'no-caption-plan' };
  }
  if (captionPlan.blocked.length !== 0) {
    return { name: 'caption-lines', verdict: 'unmeasured', reason: `caption-plan-blocked:${captionPlan.blocked.join(',')}` };
  }
  if (captionPlan.captions.length === 0) {
    return { name: 'caption-lines', verdict: 'unmeasured', reason: 'no-caption-lines' };
  }
  return captionPlan.captions
    .map((caption) => assessQc({
      ...measurements,
      captionLines: caption.lines.map((line) => ({ chars: line.text.length })),
    }, thresholds).findings.find((finding) => finding.name === 'caption-lines')!)
    .reduce((worst, finding) => worstVerdict([worst, finding]) === finding.verdict ? finding : worst);
}

async function runCaptionRender(
  production: AdProductionDeps | undefined,
  masterPath: string | undefined,
  captionPlan: CaptionPlan | undefined,
): Promise<{ readonly captionedMasterPath?: string; readonly captionBlocked?: readonly string[] }> {
  if (!masterPath || !captionPlan) return {};
  if (captionPlan.blocked.length > 0) return { captionBlocked: captionPlan.blocked };
  if (captionPlan.captions.length === 0) return { captionBlocked: ['no-caption-lines'] };
  const assembly = production?.assemblyMaterials ?? production?.assembly;
  if (!assembly?.options || !production?.render) return { captionBlocked: ['caption-render-dependencies-unavailable'] };
  const outputPath = `${assembly.options.workDir.replace(/[\\/]+$/, '')}/captioned-${assembly.options.outputName}`;
  const plan = buildCaptionRenderPlan({
    lines: captionPlan.captions.flatMap((caption) => caption.lines),
    fontPath: production.captionFontPath,
    workDir: assembly.options.workDir,
    masterPath,
    outputPath,
  });
  if (plan.blocked.length > 0) return { captionBlocked: plan.blocked };
  for (const command of plan.commands) {
    try {
      const result = await production.render.run(command.argv);
      if (result.exitCode !== 0) return { captionBlocked: [`${command.step}: ${result.stderr || `failed with exit code ${result.exitCode}`}`] };
    } catch (error) {
      return { captionBlocked: [`caption-render: ${error instanceof Error ? error.message : String(error)}`] };
    }
  }
  return { captionedMasterPath: outputPath };
}

async function measureQc(
  production: AdProductionDeps,
  plan: ReturnType<typeof buildQcMeasurementPlan>,
  commandFilter?: (step: QcMeasurementStep) => boolean,
): Promise<{ readonly measurements: ReturnType<typeof parseQcMeasurements>; readonly unavailableTextRegions?: string }> {
  const outputs: Partial<Record<QcMeasurementStep, QcMeasurementOutputs[QcMeasurementStep]>> = {};
  try {
    for (const command of plan.commands) {
      if (commandFilter && !commandFilter(command.step)) continue;
      if (!shouldRunQcMeasurementCommand(command, outputs)) {
        outputs[command.step] = { ok: false, stderr: 'skipped because OCR prerequisite failed' };
        continue;
      }
      const result = await production.render!.run(command.argv);
      outputs[command.step] = {
        ok: result.exitCode === 0,
        stdout: result.stdout,
        stderr: result.stderr,
        ...(result.raw ? { raw: result.raw } : {}),
      };
    }
  } finally {
    const cleanup = plan.commands.find((command) => command.step === 'text-cleanup');
    if (cleanup && !outputs['text-cleanup']) await production.render!.run(cleanup.argv);
  }
  return { measurements: parseQcMeasurements(plan, outputs), unavailableTextRegions: textRegionUnavailableReason(plan, outputs) };
}

function firstCaptionLine(captionPlan: CaptionPlan | undefined): { readonly startMs: number; readonly endMs: number } | undefined {
  return captionPlan?.captions.flatMap((caption) => caption.lines).find((line) => Number.isFinite(line.startMs) && Number.isFinite(line.endMs));
}

async function runQc(
  production: AdProductionDeps | undefined,
  scene: SceneSpec | undefined,
  masterPath: string | undefined,
  captionPlan: CaptionPlan | undefined,
  captionedMasterPath?: string,
): Promise<QcResult | undefined> {
  if (!production?.render || !scene || !masterPath) return undefined;
  const { measurements, unavailableTextRegions } = await measureQc(production, buildQcMeasurementPlan(scene, masterPath, production.qcPlatform ?? process.platform));
  if (unavailableTextRegions !== undefined) {
    debug.log('ad-pipeline.qc', 'text-regions-unavailable', { reason: unavailableTextRegions });
  }
  const captionHeight = measurements.resolution?.match(/^\d+x(\d+)$/)?.[1];
  const hasCaptionLines = captionPlan?.captions.some((caption) => caption.lines.length > 0) ?? false;
  const qcMeasurements: QcMeasurements = captionHeight !== undefined && hasCaptionLines
    ? { ...measurements, captionBottomPercent: CAPTION_BOTTOM_FRACTION * 100 }
    : measurements;
  const baseQc = assessQc(qcMeasurements, production.qcThresholds);
  const captionFinding = assessCaptionScreens(qcMeasurements, captionPlan, production.qcThresholds);
  const findings = baseQc.findings.map((finding) => finding.name === 'caption-lines' ? captionFinding : finding);
  const baseResult = {
    verdict: worstVerdict(findings),
    automatedVerdict: worstVerdict(findings.filter((finding) => !baseQc.manualReviewPending.includes(finding.name))),
    manualReviewPending: baseQc.manualReviewPending,
    findings,
  };
  const line = firstCaptionLine(captionPlan);
  if (!captionedMasterPath || !line) {
    debug.log('ad-pipeline.qc', 'captioned-master-absent', { reason: !captionedMasterPath ? 'captioned-master-unavailable' : 'no-caption-lines' });
    return baseResult;
  }
  const captionedPlan = buildQcMeasurementPlan(scene, captionedMasterPath, production.qcPlatform ?? process.platform, {
    textFrameAtSeconds: (line.startMs + line.endMs) / 2000,
  });
  const captionedMeasurement = await measureQc(production, captionedPlan, (step) => step === 'probe' || step.startsWith('text-'));
  const captioned = assessCaptionedQc(captionedMeasurement.measurements.detectedTextRegions, captionedMeasurement.unavailableTextRegions);
  return {
    ...baseResult,
    verdict: worstVerdict([{ name: 'master', verdict: baseResult.verdict }, { name: 'captioned', verdict: captioned.verdict }]),
    automatedVerdict: worstVerdict([{ name: 'master', verdict: baseResult.automatedVerdict }, { name: 'captioned', verdict: captioned.verdict }]),
    captioned,
  };
}

export function createAdPipelinePlan(intake: Intake, opts?: {
  readonly hasGroundingFacts?: boolean;
  readonly production?: AdProductionDeps;
  readonly mode?: AdMode;
  readonly frontRequested?: boolean;
}): AdPipelinePlan {
  const provenance = resolveAssetProvenance(intake.kind);
  const productionReadiness = assessProductionFor(opts?.production, opts?.production?.assembly?.scene);
  const productionInvariants = productionInvariantsFor(undefined, opts?.production);
  const hasGeneratedProduction = hasWiredGeneratedProduction(productionReadiness);
  const disclosure = requiresGeneratedAssetDisclosure(provenance, hasGeneratedProduction)
    ? GENERATED_ASSET_DISCLOSURE
    : undefined;
  const modeDefinition = resolveAdMode(opts?.mode);
  const draftMarker = modeDefinition.requiresDraftMarker ? DRAFT_MARKER : undefined;
  const prerequisites = intake.kind === 'url' && !opts?.hasGroundingFacts ? [GROUNDING_PREREQUISITE] : [];
  const stages: readonly AdGate[] = !opts?.frontRequested
    ? AD_GATES
    : opts.mode
      ? modeDefinition.requiredGates as readonly AdGate[]
      : AD_GATES_WITH_FRONT;
  const plan: AdPipelinePlan = {
    intake,
    provenance,
    ...(disclosure ? { disclosure } : {}),
    mode: modeDefinition.mode,
    modeDefinition,
    ...(draftMarker ? { draftMarker } : {}),
    stages,
    prerequisites,
    ...(productionInvariants ? { productionInvariants } : {}),
    productionReadiness,
    unwiredProduction: unwiredProductionFor(productionReadiness),
  };
  protectDraftMarker(plan);
  validateProvenancePlan(plan);
  validateDraftMarkerPlan(plan);
  return plan;
}

/**
 * 표면(CLI·TUI·텔레그램)이 공유하는 배선. ⛔ 표면이 단계 이름을 «갖지 않게» 하려고 여기 둔다 —
 * 표면은 「묻는 법」(ask)과 「보여 주는 법」(report)만 준다.
 */
export function createAdPipelineDeps(io: {
  readonly ask: (gate: AdGate, plan: AdPipelinePlan) => boolean | Promise<boolean>;
  readonly report: (line: string) => void;
  readonly collectPageFacts?: (url: string) => PageFacts | Promise<PageFacts>;
  readonly frontStage?: AdFrontStageInput;
  readonly collectSurvey?: OmniCrawlSurveyCollector;
  readonly selectSurveyCandidate?: (survey: SurveyResult) => string | Promise<string>;
  readonly generateConcept?: ConceptGenerator;
  /** Production callers inject the fully materialized scene, clips, and explicit master-audio selection. */
  readonly production?: AdProductionDeps;
  /** A surface-local setup failure blocks only its /ad execution. */
  readonly outputSetupError?: string;
  readonly mode?: AdMode;
  readonly outputIdentity?: AdOutputIdentity;
}): AdPipelineDeps {
  const assembly = io.production?.assemblyMaterials ?? io.production?.assembly;
  const outputSetup = assembly && io.outputIdentity && !assembly.options
    ? buildAdRunSetup({
      home: io.outputIdentity.home ?? homedir(),
      slug: io.outputIdentity.slug,
      date: io.outputIdentity.date ?? new Date().toISOString().slice(0, 10),
      version: io.outputIdentity.version,
      aspect: io.outputIdentity.aspect,
      contractsJson: '{"durationRules":{},"creditsPerSecond":{},"referenceDelivery":{}}',
    })
    : undefined;
  const production = io.production && outputSetup && !('error' in outputSetup)
    ? {
      ...io.production,
      ...(io.production.assemblyMaterials
        ? { assemblyMaterials: { ...io.production.assemblyMaterials, options: { workDir: outputSetup.workDir, outputName: outputSetup.outputName } } }
        : io.production.assembly
          ? { assembly: { ...io.production.assembly, options: { workDir: outputSetup.workDir, outputName: outputSetup.outputName } } }
          : {}),
    }
    : io.production;
  const outputSetupError = outputSetup && 'error' in outputSetup ? outputSetup.error : undefined;
  return {
    approve: (gate, plan) => {
      if (gate === 'CONCEPT_OK' && plan.survey && plan.concept) {
        io.report(`조사 후보: ${JSON.stringify(plan.survey.candidates)}`);
        io.report(`구상: ${JSON.stringify({ candidates: plan.concept.candidates, categoryForbiddenExpressions: plan.concept.categoryForbiddenExpressions, tone: plan.concept.tone })}`);
      }
      return io.ask(gate, plan);
    },
    stage: (gate, plan) => { io.report(`▶ ${gate} 승인됨 · 출처=${plan.provenance}`); },
    onGrounding: (outcome) => {
      io.report(outcome.status === 'evaluated' ? outcome.summary : `⚠ ${outcome.reason}`);
    },
    ...(io.collectPageFacts ? { collectPageFacts: io.collectPageFacts } : {}),
    ...(io.frontStage ? { frontStage: io.frontStage } : {}),
    ...(io.collectSurvey ? { collectSurvey: io.collectSurvey } : {}),
    ...(io.selectSurveyCandidate ? { selectSurveyCandidate: io.selectSurveyCandidate } : {}),
    ...(io.generateConcept ? { generateConcept: io.generateConcept } : {}),
    ...(production ? { production } : {}),
    ...(io.mode ? { mode: io.mode } : {}),
    ...(io.outputSetupError || outputSetupError ? { outputSetupError: io.outputSetupError ?? outputSetupError } : {}),
  };
}

export async function runAdPipeline(intake: Intake, deps: AdPipelineDeps): Promise<AdPipelineResult> {
  const adRunId = randomUUID();
  const requestedMode = deps.mode ?? 'medium';
  // ⛔ 앞쪽 칸을 «부탁했는지»로 먼저 가른다. 명시 모드도 앞쪽을 안 부탁한 호출의 네 게이트를 바꾸지 않는다.
  //    🔑 부분 부탁(셋 중 일부만)은 «조용히 건너뛰지» 않고 blocked 로 낸다 — 「안 돌았다」와 「못 돌았다」가 갈려야 한다.
  const frontRequested = !!(deps.frontStage || deps.collectSurvey || deps.selectSurveyCandidate || deps.generateConcept);
  let grounding: GroundingOutcome | undefined;
  const basePlan = createAdPipelinePlan(intake, {
    ...(deps.production ? { production: deps.production } : {}),
    ...(deps.mode ? { mode: deps.mode } : {}),
    frontRequested,
  });
  if (basePlan.mode !== requestedMode) {
    throw new Error(`Ad pipeline mode mismatch: requested ${requestedMode}, planned ${basePlan.mode}.`);
  }
  if (deps.outputSetupError) {
    return {
      status: 'blocked',
      plan: basePlan,
      grounding: { status: 'not-collected', reason: deps.outputSetupError },
      reason: deps.outputSetupError,
    };
  }
  debug.log('ad-pipeline.run', 'started', {
    inputKind: intake.kind,
    mode: requestedMode,
    frontRequested,
    ...productionReadinessCounts(basePlan.productionReadiness),
  });
  let plan = basePlan;
  if (frontRequested) {
    if (!deps.frontStage || !deps.collectSurvey || !deps.generateConcept) {
      const reason = '앞쪽 칸을 부탁했는데 재료가 «덜 왔다» — frontStage ⊕ collectSurvey ⊕ generateConcept 셋이 다 있어야 CONCEPT_OK 를 물을 수 있다.';
      return { status: 'blocked', plan: basePlan, grounding: { status: 'not-collected', reason }, reason };
    }
    try {
      let survey: SurveyResult;
      try {
        survey = await surveyMarket(deps.frontStage.survey, deps.collectSurvey);
      } catch (error) {
        observeAdGraphEntry(adRunId, { from: 'survey', outcome: surveyObservationOutcome(error) });
        throw error;
      }
      observeAdGraphEntry(adRunId, { from: 'survey', outcome: survey.candidates.length > 0 ? 'candidate' : 'empty' });
      const selection = deps.frontStage.selection?.trim() || (deps.selectSurveyCandidate ? (await deps.selectSurveyCandidate(survey)).trim() : '');
      if (!selection) throw new Error('A non-empty human selection is required before concept generation.');
      observeAdGraphEntry(adRunId, { from: 'select' });
      const shotParse = deps.frontStage.shotMarkdown === undefined ? undefined : parseSkillOutput(deps.frontStage.shotMarkdown);
      const concept = await createConcept({
        survey,
        selection,
        ...(deps.frontStage.skuGrounding ? { skuGrounding: deps.frontStage.skuGrounding } : {}),
        ...(shotParse?.scene ? { scene: shotParse.scene, ...(deps.frontStage.voiceId ? { voiceId: deps.frontStage.voiceId } : {}) } : {}),
      }, deps.generateConcept);
      plan = protectDraftMarker({
        ...basePlan,
        survey,
        concept,
        ...(shotParse?.sceneWarnings ? { sceneWarnings: shotParse.sceneWarnings } : {}),
        ...(shotParse && !shotParse.scene ? {
          shotParse: { missing: shotParse.missing, ...(shotParse.formatMismatch ? { formatMismatch: shotParse.formatMismatch } : {}) },
        } : {}),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { status: 'blocked', plan: basePlan, grounding: { status: 'not-collected', reason }, reason };
    }
  }

  if (intake.kind === 'url') {
    if (deps.collectPageFacts) {
      const verdict = evaluateGrounding(await deps.collectPageFacts(intake.url));
      grounding = { status: 'evaluated', verdict, summary: formatVerdict(verdict) };
    } else {
      grounding = { status: 'not-collected', reason: GROUNDING_COLLECTOR_MISSING };
    }
    await deps.onGrounding(grounding);
    // ⛔⭐ 「멈추는」 경로에서도 plan 이 접지를 «지녀야» 한다 — blocked 를 받는 소비자도
    //    plan 하나만 보고 판단한다. 그래서 early return «앞»에서 붙인다(#17899 가 뒤에 뒀다).
    attachGrounding(plan, grounding);
    // ⛔ 접지는 이 파이프라인의 «전제»다. 못 쟀는데 진행하면 근거 없는 광고가 된다.
    //    ⇒ 여기서 «멈춘다». 사람에게 게이트를 묻지도 않는다.
    if (grounding.status === 'not-collected') {
      return { status: 'blocked', plan, grounding, reason: grounding.reason };
    }
  }

  const requiredGates = frontRequested ? plan.stages : basePlan.stages;
  for (const gate of requiredGates) {
    if (!await deps.approve(gate, plan)) {
      debug.log('ad-pipeline.run', 'gate-rejected', { gate });
      observeAdGraphGateEntry(adRunId, gate, 'fail');
      return { status: 'rejected', plan, stoppedGate: gate, ...(grounding ? { grounding } : {}) };
    }
    debug.log('ad-pipeline.run', 'gate-approved', { gate });
    observeAdGraphGateEntry(adRunId, gate, 'pass');
    validateAdPipelineModePlan(plan, requestedMode);
    await deps.stage(gate, plan);
  }
  validateAdPipelineModePlan(plan, requestedMode);
  const productionScene = productionSceneFor(plan.concept, deps.production);
  const productionVoiceover = productionVoiceoverFor(plan.concept, deps.production);
  const productionInvariants = productionInvariantsFor(plan.concept, deps.production);
  const productionReadiness = assessProductionFor(deps.production, productionScene.scene, plan.concept);
  const hasGeneratedProduction = hasWiredGeneratedProduction(productionReadiness);
  const disclosure = plan.disclosure ?? (requiresGeneratedAssetDisclosure(plan.provenance, hasGeneratedProduction)
    ? GENERATED_ASSET_DISCLOSURE
    : undefined);
  plan = protectDraftMarker({
    ...plan,
    ...(disclosure ? { disclosure } : {}),
    ...(productionScene.provenance ? { productionScene: productionScene.provenance } : {}),
    ...(productionVoiceover.provenance ? { productionVoiceover: productionVoiceover.provenance } : {}),
    ...(productionInvariants ? { productionInvariants } : {}),
    productionReadiness,
    unwiredProduction: unwiredProductionFor(productionReadiness),
  });
  const shooting = await runShooting(deps.production, productionScene.scene, plan.mode);
  const shootRun = shooting?.shootRun;
  let materialized: MaterializedShootClips | undefined;
  let assemblyRun: AssemblyRunResult | undefined;
  let soundPlan: SoundPlanRunResult | undefined;
  let captionPlan: CaptionPlan | undefined;
  let postShootBlocked: PostShootFailure | undefined;
  try {
    materialized = suppliedAssemblyClips(deps.production) === undefined
      ? await materializeSuccessfulShootClips(shootRun, deps.production?.shootClipRetention)
      : undefined;
  } catch (error) {
    postShootBlocked = postShootFailure('clip-retention', error, materialized);
  }
  if (!postShootBlocked) try {
    soundPlan = await runSoundPlan(
      productionVoiceover.voiceover ? { ...deps.production, voiceover: productionVoiceover.voiceover } : deps.production,
      productionScene.scene,
    );
    captionPlan = soundPlan?.captionPlan;
  } catch (error) {
    postShootBlocked = postShootFailure('sound', error);
    if (!postShootBlocked.clips) {
      postShootBlocked = new PostShootFailure(
        postShootBlocked.stage,
        postShootBlocked.message,
        materialized?.clips ?? suppliedAssemblyClips(deps.production),
        materialized?.unprobed ?? postShootBlocked.unprobedClipBeats,
      );
    }
  }
  if (!postShootBlocked) {
    try {
      assemblyRun = await runAssembly(deps.production, productionScene.scene, materialized, soundPlan?.soundtrackPath);
    } catch (error) {
      postShootBlocked = postShootFailure('assembly', error, materialized);
    }
  }
  const assembly = deps.production?.assemblyMaterials ?? deps.production?.assembly;
  const explicitMasterAudio = assembly?.masterAudio ?? assembly?.options?.masterAudio;
  const selectedMasterAudio = explicitMasterAudio
    ?? (soundPlan?.soundtrackPath ? { kind: 'soundtrack' as const, path: soundPlan.soundtrackPath } : undefined);
  if (assemblyRun?.masterPath && selectedMasterAudio?.kind !== 'soundtrack') {
    plan = protectDraftMarker({
      ...plan,
      masterAudioReason: selectedMasterAudio?.kind === 'silent'
        ? 'caller-selected-silent-master-audio'
        : 'no-sound-plan-output',
    });
  }
  const captionRender = postShootBlocked ? {} : await runCaptionRender(deps.production, assemblyRun?.masterPath, captionPlan);
  const qc = postShootBlocked ? undefined : await runQc(
    deps.production,
    productionScene.scene,
    assemblyRun?.masterPath,
    captionPlan,
    captionRender.captionedMasterPath,
  );
  const shootAssets = shootRun ? shootAssetResults(shootRun) : undefined;
  const unpriced = shooting?.unpriced;
  const trimDisagreement = assemblyRun?.trimDisagreement;
  const captionBlocked = captionRender.captionBlocked;
  debug.log('ad-pipeline.run', 'production-readiness', productionReadinessCounts(plan.productionReadiness));
  debug.log('ad-pipeline.run', 'completion-reasons', {
    ...(shootAssets ? { shootAssets: { count: shootAssets.length, names: shootAssets.map(({ beatIndex }) => `Beat ${beatIndex + 1}`) } } : {}),
    ...(unpriced ? { unpriced: unpriced.map(({ beatIndex, reason }) => ({ beatIndex, reason })) } : {}),
    ...(trimDisagreement ? { trimDisagreement } : {}),
    ...(shootAssets?.some((asset) => asset.limitedBy !== undefined)
      ? { limitedBy: shootAssets.flatMap((asset) => asset.limitedBy === undefined ? [] : [asset.limitedBy]) }
      : {}),
    ...(captionBlocked ? { captionBlocked } : {}),
    ...(plan.masterAudioReason ? { masterAudioReason: plan.masterAudioReason } : {}),
    ...(plan.shotParse ? { shotParse: plan.shotParse } : {}),
    ...(plan.disclosure ? { disclosure: plan.disclosure } : {}),
  });
  return {
    status: 'gates-approved',
    plan,
    ...(grounding ? { grounding } : {}),
    ...(shootRun ? { shootRun, shootAssets } : {}),
    ...(shooting ? { unpriced } : {}),
    ...(assemblyRun ? { trimDisagreement: trimDisagreement ?? [] } : {}),
    ...(postShootBlocked
      ? {
        blocked: [`${postShootBlocked.stage}: ${postShootBlocked.message}`],
        ...(postShootBlocked.clips ? { clips: postShootBlocked.clips } : {}),
        ...(postShootBlocked.unprobedClipBeats ? { unprobedClipBeats: postShootBlocked.unprobedClipBeats } : {}),
      }
      : {}),
    ...(assemblyRun?.unprobedClipBeats ? { unprobedClipBeats: assemblyRun.unprobedClipBeats } : {}),
    ...(assemblyRun?.blocked ? { blocked: assemblyRun.blocked, clips: assemblyRun.clips } : {}),
    ...(assemblyRun?.masterPath ? { masterPath: assemblyRun.masterPath } : {}),
    ...(assemblyRun?.safezonePath ? { safezonePath: assemblyRun.safezonePath } : {}),
    ...(captionPlan ? { captionPlan } : {}),
    ...(captionRender.captionedMasterPath ? { captionedMasterPath: captionRender.captionedMasterPath } : {}),
    ...(captionRender.captionBlocked ? { captionBlocked: captionRender.captionBlocked } : {}),
    ...(qc ? { qc } : {}),
    productionReadiness: plan.productionReadiness,
    unwiredProduction: plan.unwiredProduction,
  };
}
