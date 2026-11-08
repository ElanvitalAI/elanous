import { resolveAdMode, type AdMode } from './mode.js';
import type { SceneSpec } from './scene-spec.js';

type MissingReference = { readonly what: string; readonly required: number; readonly available: number };
type OverLimitReference = { readonly assetCount: number; readonly limit: number };

export type ReferenceReadiness =
  | { readonly kind: 'ready'; readonly assets: readonly string[] }
  | { readonly kind: 'missing'; readonly missing: readonly MissingReference[]; readonly overLimit?: OverLimitReference }
  | { readonly kind: 'identity-unresolved' }
  | { readonly kind: 'over-limit'; readonly assetCount: number; readonly limit: number };

export type ReferenceDeliveryReadiness =
  | { readonly kind: 'configured'; readonly delivery: ReferenceDelivery }
  | { readonly kind: 'unconfigured' };

export interface ShootCommand {
  readonly beatIndex: number;
  readonly jobType: string;
  readonly durationSeconds?: number;
  readonly trimToSeconds?: number;
  readonly args: readonly string[];
  readonly referenceReadiness?: ReferenceReadiness;
  readonly referenceDeliveryReadiness?: ReferenceDeliveryReadiness;
  readonly estimatedCredits?: number;
}

export interface ShootPlan {
  readonly commands: readonly ShootCommand[];
  readonly totalEstimatedCredits?: number;
  readonly unpriced: readonly number[];
  readonly blocked: readonly string[];
}

export type DurationRule =
  | { readonly minimumSeconds: number }
  | { readonly allowedSeconds: readonly number[] };

/** Injected CLI contract for a model's ready reference assets. */
export type ReferenceDelivery =
  | { readonly kind: 'repeated'; readonly flag: string }
  | { readonly kind: 'single'; readonly flag: string };

export interface BuildShootPlanOptions {
  readonly mode: AdMode;
  /** Legacy fallback used only when a model-specific duration rule is absent. */
  readonly minGeneratableSeconds?: number;
  readonly durationRules?: Readonly<Record<string, DurationRule>>;
  readonly creditsPerSecond?: Readonly<Record<string, number>>;
  /** Injected media IDs or paths, keyed by ProductionCheck.reference.what. */
  readonly referenceAssets?: Readonly<Record<string, readonly string[]>>;
  /** Injected model capabilities; absent limits intentionally disable limit checks. */
  readonly referenceLimits?: Readonly<Record<string, { readonly maxImageReferences?: number; readonly maxReferenceFiles?: number }>>;
  /** Injected delivery contract keyed by model; absent entries visibly omit reference arguments. */
  readonly referenceDelivery?: Readonly<Record<string, ReferenceDelivery>>;
}

function validMinimum(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value > 0;
}

function durationFor(requestedSeconds: number, rule: DurationRule | undefined): number | undefined {
  if (rule === undefined) return undefined;
  if ('minimumSeconds' in rule) return validMinimum(rule.minimumSeconds)
    ? Math.max(requestedSeconds, rule.minimumSeconds)
    : undefined;
  return rule.allowedSeconds
    .filter((seconds) => Number.isFinite(seconds) && seconds > 0)
    .sort((left, right) => left - right)
    .find((seconds) => seconds >= requestedSeconds);
}

type ReferenceRequirement = { readonly what: string; readonly count: number; readonly assets: readonly string[] };

function referenceReadiness(
  requirements: readonly ReferenceRequirement[],
  assets: readonly string[],
  limits: { readonly maxImageReferences?: number; readonly maxReferenceFiles?: number } | undefined,
): ReferenceReadiness {
  const missing = requirements.flatMap(({ what, count, assets: availableAssets }) => (
    availableAssets.length < count ? [{ what, required: count, available: availableAssets.length }] : []
  ));
  const limit = Math.min(limits?.maxImageReferences ?? Infinity, limits?.maxReferenceFiles ?? Infinity);
  const overLimit = assets.length > limit ? { assetCount: assets.length, limit } : undefined;
  if (missing.length > 0) return { kind: 'missing', missing, ...(overLimit === undefined ? {} : { overLimit }) };
  if (overLimit !== undefined) return { kind: 'over-limit', ...overLimit };
  return { kind: 'ready', assets };
}

export function buildShootPlan(scene: SceneSpec, options: BuildShootPlanOptions): ShootPlan {
  const blocked: string[] = [];
  /** ⛔ 계획 «전체»를 무효로 만드는 막힘. 비트 단위 막힘(빈 프롬프트 등)과 «다른 값»이다. */
  const planLevelBlocked: string[] = [];
  const commands: ShootCommand[] = [];
  const unpriced: number[] = [];
  const mode = resolveAdMode(options.mode);
  const establishedIdentityAssetsByWhat = new Map<string, readonly string[]>();
  const latestIdentityAssetsByWhat = new Map<string, readonly string[]>();

  const needsFallbackDurationRule = scene.beats.some((beat) => options.durationRules?.[beat.model] === undefined);
  if (needsFallbackDurationRule && options.minGeneratableSeconds !== undefined && !validMinimum(options.minGeneratableSeconds)) {
    blocked.push('invalid-min-generatable-seconds');
    planLevelBlocked.push('invalid-min-generatable-seconds');
  }
  if (scene.beats.length > mode.cutCount.max) {
    blocked.push(`mode-cut-limit-exceeded:${options.mode}:${mode.cutCount.max}`);
    planLevelBlocked.push(`mode-cut-limit-exceeded:${options.mode}:${mode.cutCount.max}`);
  }
  for (const [beatIndex, beat] of scene.beats.entries()) {
    if (!beat.promptCore.trim()) {
      blocked.push(`empty-prompt:beat-${beatIndex + 1}`);
      unpriced.push(beatIndex);
      continue;
    }

    const missingLegibleWriting = beat.checks
      .filter((check): check is Extract<typeof check, { readonly kind: 'legible-writing' }> => check.kind === 'legible-writing')
      .find((check) => (options.referenceAssets?.[check.what]?.length ?? 0) === 0);
    if (missingLegibleWriting) {
      blocked.push(`missing-legible-writing-reference:beat-${beatIndex + 1}:${missingLegibleWriting.what}`);
      unpriced.push(beatIndex);
      continue;
    }

    const requestedSeconds = beat.endSec - beat.startSec;
    if (!Number.isFinite(requestedSeconds) || requestedSeconds <= 0) {
      blocked.push(`invalid-duration:beat-${beatIndex + 1}`);
      continue;
    }

    const durationSeconds = durationFor(
      requestedSeconds,
      options.durationRules?.[beat.model] ?? (validMinimum(options.minGeneratableSeconds)
        ? { minimumSeconds: options.minGeneratableSeconds }
        : undefined),
    );
    if (durationSeconds === undefined) {
      unpriced.push(beatIndex);
      continue;
    }
    const declaredReferences = beat.checks.filter((check): check is Extract<typeof check, { readonly kind: 'reference' }> => check.kind === 'reference');
    const declaredLegibleWriting = beat.checks.filter((check): check is Extract<typeof check, { readonly kind: 'legible-writing' }> => check.kind === 'legible-writing');
    const hasIdentityCheck = beat.checks.some((check) => check.kind === 'identity-check');
    const identityRequirements = declaredReferences.map((check) => ({
      what: check.what,
      count: check.count,
      assets: options.referenceAssets?.[check.what] ?? [],
    }));
    const legibleWritingRequirements = declaredLegibleWriting.map((check) => ({
      what: check.what,
      count: 1,
      assets: (options.referenceAssets?.[check.what] ?? []).slice(0, 1),
    }));
    const hasDeclaredReferences = identityRequirements.length > 0;
    const hasEstablishedIdentity = establishedIdentityAssetsByWhat.size > 0;
    const selectedIdentityRequirements = hasIdentityCheck && hasEstablishedIdentity
      ? identityRequirements.map((requirement) => ({
        ...requirement,
        assets: establishedIdentityAssetsByWhat.get(requirement.what) ?? [],
      }))
      : identityRequirements.map((requirement) => ({
        ...requirement,
        assets: requirement.assets.slice(0, requirement.count),
      }));
    const selectedRequirements = [...selectedIdentityRequirements, ...legibleWritingRequirements];
    const assets = hasIdentityCheck && !hasDeclaredReferences
      ? [...latestIdentityAssetsByWhat.values()].flat().concat(legibleWritingRequirements.flatMap((requirement) => requirement.assets))
      : selectedRequirements.flatMap((requirement) => requirement.assets);
    const readiness = hasIdentityCheck && !hasDeclaredReferences && !hasEstablishedIdentity
      ? { kind: 'identity-unresolved' as const }
      : referenceReadiness(selectedRequirements, assets, options.referenceLimits?.[beat.model]);
    const delivery = options.referenceDelivery?.[beat.model];
    const deliveredAssets = readiness.kind === 'ready' && delivery?.kind === 'single'
      ? readiness.assets.slice(0, 1)
      : readiness.kind === 'ready' && delivery?.kind === 'repeated' ? readiness.assets : [];
    const deliveredRequirements = selectedRequirements.map((requirement) => ({
      ...requirement,
      assets: deliveredAssets.filter((asset) => requirement.assets.includes(asset)),
    }));
    const commandReadiness = readiness.kind === 'ready' || readiness.kind === 'missing'
      ? referenceReadiness(deliveredRequirements, deliveredAssets, options.referenceLimits?.[beat.model])
      : readiness;
    const deliveryReadiness = delivery === undefined
      ? { kind: 'unconfigured' as const }
      : { kind: 'configured' as const, delivery };
    if (hasDeclaredReferences && readiness.kind === 'ready') {
      for (const requirement of selectedIdentityRequirements) {
        const deliveredForRequirement = deliveredAssets.filter((asset) => requirement.assets.includes(asset));
        establishedIdentityAssetsByWhat.set(requirement.what, deliveredForRequirement);
      }
      latestIdentityAssetsByWhat.clear();
      for (const requirement of selectedIdentityRequirements) {
        const deliveredForRequirement = deliveredAssets.filter((asset) => requirement.assets.includes(asset));
        latestIdentityAssetsByWhat.set(requirement.what, deliveredForRequirement);
      }
    } else if (hasIdentityCheck && readiness.kind === 'ready') {
      const deliveredIdentityAssets = [...latestIdentityAssetsByWhat.entries()].map(([what, identityAssets]) => [
        what,
        deliveredAssets.filter((asset) => identityAssets.includes(asset)),
      ] as const);
      latestIdentityAssetsByWhat.clear();
      for (const [what, identityAssets] of deliveredIdentityAssets) {
        establishedIdentityAssetsByWhat.set(what, identityAssets);
        latestIdentityAssetsByWhat.set(what, identityAssets);
      }
    }
    const referenceArgs = delivery === undefined
      ? []
      : deliveredAssets.flatMap((asset) => [delivery.flag, asset]);

    const creditsPerSecond = options.creditsPerSecond?.[beat.model];
    const estimatedCredits = creditsPerSecond === undefined ? undefined : durationSeconds * creditsPerSecond;
    if (estimatedCredits === undefined) unpriced.push(beatIndex);

    commands.push({
      beatIndex,
      jobType: beat.model,
      durationSeconds,
      ...(durationSeconds > requestedSeconds ? { trimToSeconds: requestedSeconds } : {}),
      args: ['--prompt', beat.promptCore, '--aspect-ratio', scene.aspectRatio, ...referenceArgs],
      referenceReadiness: commandReadiness,
      referenceDeliveryReadiness: deliveryReadiness,
      ...(estimatedCredits === undefined ? {} : { estimatedCredits }),
    });
  }

  const totalEstimatedCredits = unpriced.length === 0
    ? commands.reduce((total, command) => total + (command.estimatedCredits ?? 0), 0)
    : undefined;

  // ⛔⭐⭐ **막힘이 «두 종류»다 — 섞으면 둘 다 틀린다.**
  //
  //   ⓐ «비트 단위» 막힘 (빈 프롬프트 · 잘못된 길이)
  //        → 그 비트만 «빼고» 나머지는 «그대로 낸다».
  //          🔑 부분 성공을 통째로 버리면 쓸 수 있었던 넷도 잃는다.
  //   ⓑ «계획 단위» 막힘 (모드 컷 상한 초과 · 최소 길이가 무효)
  //        → ***명령을 «하나도» 내지 않는다.***
  //          🩸 초판은 이 경우에도 명령을 그대로 냈다. 그러면
  //             「blocked 를 안 보고 commands 만 쓰는」 소비자가 «과금»한다.
  //          🔑 안전은 「소비자가 조심하는 것」이 아니라 ***그 상태를 «만들지 않는 것»***이다.
  if (planLevelBlocked.length > 0) {
    // ⛔ `unpriced` 는 «전 비트»를 담는다 — 「아무 비트도 값을 못 받았다」가 참이기 때문이다.
    //    빈 배열로 두면 「전부 값을 받았다」로 읽힌다(같은 모양, 반대 뜻).
    return { commands: [], unpriced: scene.beats.map((_, index) => index), blocked };
  }

  return {
    commands,
    ...(totalEstimatedCredits === undefined ? {} : { totalEstimatedCredits }),
    unpriced,
    blocked,
  };
}
