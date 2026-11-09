import { isFiniteNumber } from '../primitives/guards.js';
export interface QcMeasurements {
  readonly audioPeakDb?: number;
  readonly dialogueLufs?: number;
  readonly duckingDb?: number;
  readonly captionLines?: readonly { readonly chars: number }[];
  /** 화면 아래에서 «몇 퍼센트» 위인가 — ⛔ 0~1 «비율»이 아니라 **20~100 퍼센트**다.
   *  🩸 초판 이름이 `captionBottomRatio` 였고, 그 이름 때문에 검토자가 «두 번» 0.25 를 넣었다.
   *  ⇒ 이름이 단위를 거짓말하면 다음 사람이 같은 자리를 밟는다. */
  readonly captionBottomPercent?: number;
  readonly safeAreaViolations?: readonly string[];
  readonly aspectRatio?: string;
  readonly resolution?: string;
  readonly colorDistanceBetweenCuts?: readonly number[];
  /** Intra-cut RGB distances used to detect frozen rendered frames. */
  readonly colorDistanceWithinCuts?: readonly number[];
  readonly frameDiffVariance?: number;
  /** Whether rendered pixels contain intentional visual content; undefined means this axis was not measured. */
  readonly renderedContentPresent?: boolean;
  readonly detectedTextRegions?: number;
  readonly durationSeconds?: number;
  /** Identifies whether durationSeconds measures one generated cut or the assembled master. */
  readonly durationScope?: 'cut' | 'master';
  readonly negativePromptPresent?: boolean;
}

export interface QcDurationRange {
  readonly minimumSeconds: number;
  readonly maximumSeconds: number;
}

export type QcVerdict = 'ok' | 'regenerate' | 'grade-fix' | 'warn' | 'unmeasured';

export interface QcThresholds {
  /** No default: compared against |dialogueLufs − (−14)|; this is a non-negative LUFS difference and is not limited to single digits. */
  readonly dialogueLufsTolerance?: number;
  /** No default: compared against Euclidean RGB distance between adjacent cut frames; RGB-byte distances range from 0–441. */
  readonly colorDistance?: number;
  /** No default: compared against frame-to-frame difference variance; this is a non-negative variance measurement. */
  readonly frameDiffVariance?: number;
  /** No default: callers must supply the calibrated range for each measured duration scope. */
  readonly durationRanges?: Readonly<Partial<Record<'cut' | 'master', QcDurationRange>>>;
}

export interface QcFinding {
  readonly name: string;
  readonly verdict: QcVerdict;
  readonly reason?: string;
}

export interface QcResult {
  readonly verdict: QcVerdict;
  readonly automatedVerdict: QcVerdict;
  readonly manualReviewPending: readonly string[];
  readonly findings: readonly QcFinding[];
  readonly captioned?: {
    readonly verdict: QcVerdict;
    readonly findings: readonly QcFinding[];
  };
}

const MANUAL_REVIEW_AXES = [
  'finger-distortion',
  'face-morphing',
  'background-distortion',
  'identity-consistency',
] as const;

const MEASUREMENT_AXES = [
  'audio-peak',
  'dialogue-loudness',
  'ducking',
  'caption-lines',
  'caption-bottom-percent',
  'safe-area',
  'aspect-ratio',
  'resolution',
  'color-distance-between-cuts',
  'color-distance-within-cuts',
  'frame-diff-variance',
  'rendered-content-presence',
  'unexpected-text',
  'duration-unscoped',
  'negative-prompt',
] as const;

const VERDICT_PRIORITY: Readonly<Record<QcVerdict, number>> = {
  ok: 0,
  unmeasured: 1,
  warn: 2,
  'grade-fix': 3,
  regenerate: 4,
};

function addFinding(findings: QcFinding[], name: string, verdict: QcFinding['verdict'], reason?: string): void {
  findings.push(reason === undefined ? { name, verdict } : { name, verdict, reason });
}

function isNonNegativeInteger(value: unknown): value is number {
  return isFiniteNumber(value) && Number.isInteger(value) && value >= 0;
}

function isFiniteThreshold(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0;
}

function isDurationRange(value: unknown): value is QcDurationRange {
  return typeof value === 'object' && value !== null
    && 'minimumSeconds' in value && 'maximumSeconds' in value
    && isFiniteThreshold(value.minimumSeconds) && isFiniteThreshold(value.maximumSeconds)
    && value.minimumSeconds <= value.maximumSeconds;
}

function assessNumeric(
  findings: QcFinding[],
  name: string,
  value: number | undefined,
  reason: string,
  outsidePolicy: (value: number) => boolean,
): void {
  if (!isFiniteNumber(value)) {
    addFinding(findings, name, 'unmeasured', reason);
  } else if (outsidePolicy(value)) {
    addFinding(findings, name, 'regenerate');
  } else {
    addFinding(findings, name, 'ok');
  }
}

function aspectRatioFromResolution(resolution: string | undefined): string | undefined {
  const match = resolution?.match(/^(\d+)x(\d+)$/);
  if (!match) return undefined;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!isFiniteNumber(width) || !isFiniteNumber(height) || width <= 0 || height <= 0) return undefined;
  let divisor = Math.min(width, height);
  let remainder = Math.max(width, height);
  while (remainder !== 0) {
    const next = divisor % remainder;
    divisor = remainder;
    remainder = next;
  }
  return `${width / divisor}:${height / divisor}`;
}

export function worstVerdict(findings: readonly QcFinding[]): QcVerdict {
  return findings.reduce<QcVerdict>(
    (worst, finding) => VERDICT_PRIORITY[finding.verdict] > VERDICT_PRIORITY[worst] ? finding.verdict : worst,
    'ok',
  );
}

export function assessCaptionedQc(
  detectedTextRegions: number | undefined,
  unavailableReason?: string,
): { readonly verdict: QcVerdict; readonly findings: readonly QcFinding[] } {
  const finding: QcFinding = !isNonNegativeInteger(detectedTextRegions)
    ? { name: 'caption-burned-in', verdict: 'unmeasured', reason: unavailableReason ?? 'no-detected-text-regions' }
    : detectedTextRegions === 0
      ? { name: 'caption-burned-in', verdict: 'regenerate' }
      : { name: 'caption-burned-in', verdict: 'ok' };
  return { verdict: finding.verdict, findings: [finding] };
}

/**
 * Applies RFC A3's documented mastering and artifact policy to precomputed measurements.
 * This synchronous module neither measures media nor executes a remediation.
 */
export function assessQc(measurements: QcMeasurements, thresholds: QcThresholds = {}): QcResult {
  const findings: QcFinding[] = [];

  assessNumeric(findings, 'audio-peak', measurements.audioPeakDb, 'no-audio-peak', (value) => value > -1);
  if (!isFiniteNumber(measurements.dialogueLufs) || !isFiniteThreshold(thresholds.dialogueLufsTolerance)) {
    addFinding(
      findings,
      'dialogue-loudness',
      'unmeasured',
      !isFiniteNumber(measurements.dialogueLufs) ? 'no-dialogue-lufs' : 'no-dialogue-lufs-tolerance',
    );
  } else if (Math.abs(measurements.dialogueLufs - -14) > thresholds.dialogueLufsTolerance) {
    addFinding(findings, 'dialogue-loudness', 'regenerate');
  } else {
    addFinding(findings, 'dialogue-loudness', 'ok');
  }
  assessNumeric(findings, 'ducking', measurements.duckingDb, 'no-ducking', (value) => value < -10 || value > -6);

  if (measurements.captionLines === undefined
    || !Array.isArray(measurements.captionLines)
    || measurements.captionLines.some((line) => !line || !isNonNegativeInteger(line.chars))) {
    addFinding(findings, 'caption-lines', 'unmeasured', 'no-caption-lines-measurement');
  // The 12-character density minimum applies to the first line only: a short
  // trailing line is normal when a 17–24-character dialogue wraps at 16 characters.
  } else if (measurements.captionLines.length > 2
    || measurements.captionLines.some((line) => line.chars > 16)
    || measurements.captionLines[0]?.chars < 12) {
    addFinding(findings, 'caption-lines', 'regenerate');
  } else {
    addFinding(findings, 'caption-lines', 'ok');
  }

  assessNumeric(findings, 'caption-bottom-percent', measurements.captionBottomPercent, 'no-caption-bottom-percent', (value) => value < 20 || value > 100);

  if (measurements.safeAreaViolations === undefined || !Array.isArray(measurements.safeAreaViolations)
    || measurements.safeAreaViolations.some((violation) => typeof violation !== 'string')) {
    addFinding(findings, 'safe-area', 'unmeasured', 'no-safe-area-violations');
  } else if (measurements.safeAreaViolations.length > 0) {
    addFinding(findings, 'safe-area', 'regenerate');
  } else {
    addFinding(findings, 'safe-area', 'ok');
  }

  const aspectRatio = measurements.aspectRatio?.trim()
    ? measurements.aspectRatio
    : aspectRatioFromResolution(measurements.resolution);
  if (aspectRatio === undefined) addFinding(findings, 'aspect-ratio', 'unmeasured', 'no-aspect-ratio');
  else if (aspectRatio !== '9:16') addFinding(findings, 'aspect-ratio', 'regenerate');
  else addFinding(findings, 'aspect-ratio', 'ok');

  if (measurements.resolution === undefined || !measurements.resolution.trim()) addFinding(findings, 'resolution', 'unmeasured', 'no-resolution');
  else if (measurements.resolution !== '1080x1920') addFinding(findings, 'resolution', 'regenerate');
  else addFinding(findings, 'resolution', 'ok');

  if (measurements.colorDistanceBetweenCuts === undefined
    || !Array.isArray(measurements.colorDistanceBetweenCuts)
    || !isFiniteThreshold(thresholds.colorDistance)
    || measurements.colorDistanceBetweenCuts.some((distance) => !isFiniteNumber(distance) || distance < 0)) {
    addFinding(
      findings,
      'color-distance-between-cuts',
      'unmeasured',
      measurements.colorDistanceBetweenCuts === undefined
        || !Array.isArray(measurements.colorDistanceBetweenCuts)
        || measurements.colorDistanceBetweenCuts.some((distance) => !isFiniteNumber(distance) || distance < 0)
        ? 'no-color-distance-between-cuts'
        : 'no-color-distance-threshold',
    );
  } else if (measurements.colorDistanceBetweenCuts.some((distance) => distance > thresholds.colorDistance!)) {
    addFinding(findings, 'color-distance-between-cuts', 'grade-fix');
  } else {
    addFinding(findings, 'color-distance-between-cuts', 'ok');
  }

  if (measurements.colorDistanceWithinCuts === undefined
    || !Array.isArray(measurements.colorDistanceWithinCuts)
    || measurements.colorDistanceWithinCuts.length === 0
    || measurements.colorDistanceWithinCuts.some((distance) => !isFiniteNumber(distance) || distance < 0)) {
    addFinding(findings, 'color-distance-within-cuts', 'unmeasured', 'no-color-distance-within-cuts');
  } else if (measurements.colorDistanceWithinCuts.every((distance) => distance === 0)) {
    addFinding(findings, 'color-distance-within-cuts', 'regenerate');
  } else {
    addFinding(findings, 'color-distance-within-cuts', 'ok');
  }

  if (!isFiniteNumber(measurements.frameDiffVariance) || measurements.frameDiffVariance < 0
    || !isFiniteThreshold(thresholds.frameDiffVariance)) {
    addFinding(
      findings,
      'frame-diff-variance',
      'unmeasured',
      !isFiniteNumber(measurements.frameDiffVariance) || measurements.frameDiffVariance < 0
        ? 'no-frame-diff-variance'
        : 'no-frame-diff-variance-threshold',
    );
  } else if (measurements.frameDiffVariance > thresholds.frameDiffVariance) {
    addFinding(findings, 'frame-diff-variance', 'regenerate');
  } else {
    addFinding(findings, 'frame-diff-variance', 'ok');
  }

  if (typeof measurements.renderedContentPresent !== 'boolean') {
    addFinding(findings, 'rendered-content-presence', 'unmeasured', 'no-rendered-content-presence');
  } else if (!measurements.renderedContentPresent) {
    addFinding(findings, 'rendered-content-presence', 'regenerate');
  } else {
    addFinding(findings, 'rendered-content-presence', 'ok');
  }

  if (!isNonNegativeInteger(measurements.detectedTextRegions)) addFinding(findings, 'unexpected-text', 'unmeasured', 'no-detected-text-regions');
  // This applies only where the generation prompt forbids text; intentional logos are out of scope.
  else if (measurements.detectedTextRegions > 0) addFinding(findings, 'unexpected-text', 'regenerate');
  else addFinding(findings, 'unexpected-text', 'ok');

  const durationScope = measurements.durationScope;
  const durationName = durationScope === 'cut' ? 'duration-cut' : durationScope === 'master' ? 'duration-master' : 'duration-unscoped';
  const durationRange = durationScope === undefined ? undefined : thresholds.durationRanges?.[durationScope];
  if (durationScope === undefined || !isFiniteNumber(measurements.durationSeconds) || measurements.durationSeconds < 0 || !isDurationRange(durationRange)) {
    addFinding(
      findings,
      durationName,
      'unmeasured',
      durationScope === undefined ? 'no-duration-scope' : !isFiniteNumber(measurements.durationSeconds) || measurements.durationSeconds < 0 ? 'no-duration-seconds' : 'no-duration-range',
    );
  } else if (measurements.durationSeconds < durationRange.minimumSeconds || measurements.durationSeconds > durationRange.maximumSeconds) {
    addFinding(findings, durationName, 'warn');
  } else {
    addFinding(findings, durationName, 'ok');
  }

  if (measurements.negativePromptPresent === undefined || typeof measurements.negativePromptPresent !== 'boolean') {
    addFinding(findings, 'negative-prompt', 'unmeasured', 'no-negative-prompt-presence');
  } else if (!measurements.negativePromptPresent) {
    addFinding(findings, 'negative-prompt', 'warn');
  } else {
    addFinding(findings, 'negative-prompt', 'ok');
  }

  for (const axis of MANUAL_REVIEW_AXES) addFinding(findings, axis, 'unmeasured', 'manual-review-required');

  return {
    verdict: worstVerdict(findings),
    automatedVerdict: worstVerdict(findings.filter((finding) => !(MANUAL_REVIEW_AXES as readonly string[]).includes(finding.name))),
    manualReviewPending: MANUAL_REVIEW_AXES.filter((axis) => findings.some((finding) => finding.name === axis && finding.verdict === 'unmeasured')),
    findings,
  };
}

export const QC_UNMEASURED_AXES = [...MEASUREMENT_AXES, ...MANUAL_REVIEW_AXES] as const;
